//! WebSocket connection with state management and auto-reconnect.

use chrono::Utc;
use dioxus::prelude::*;
use forumall_shared::{ClientCommand, ServerEvent, WsEnvelope};
use futures_channel::mpsc::{unbounded, UnboundedReceiver, UnboundedSender};
use futures_util::StreamExt;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;
use web_sys::js_sys;

/// Connection state for a WebSocket
#[derive(Debug, Clone, PartialEq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting { attempt: u32 },
    Failed { reason: String },
}

impl ConnectionState {
    pub fn is_connected(&self) -> bool {
        matches!(self, ConnectionState::Connected)
    }

    pub fn is_connecting(&self) -> bool {
        matches!(
            self,
            ConnectionState::Connecting | ConnectionState::Reconnecting { .. }
        )
    }
}

/// Configuration for auto-reconnect behavior
#[derive(Debug, Clone)]
pub struct ReconnectConfig {
    /// Maximum number of reconnect attempts (0 = infinite)
    pub max_attempts: u32,
    /// Initial delay in milliseconds
    pub initial_delay_ms: u32,
    /// Maximum delay in milliseconds
    pub max_delay_ms: u32,
    /// Multiplier for exponential backoff
    pub backoff_multiplier: f32,
}

impl Default for ReconnectConfig {
    fn default() -> Self {
        Self {
            max_attempts: 10,
            initial_delay_ms: 1000,
            max_delay_ms: 30000,
            backoff_multiplier: 1.5,
        }
    }
}

impl ReconnectConfig {
    /// Calculate delay for a given attempt number
    pub fn delay_for_attempt(&self, attempt: u32) -> u32 {
        let delay = self.initial_delay_ms as f32 * self.backoff_multiplier.powi(attempt as i32);
        (delay as u32).min(self.max_delay_ms)
    }
}

/// Handle for sending commands through a WebSocket connection
#[derive(Clone)]
pub struct WsHandle {
    sender: UnboundedSender<WsEnvelope<ClientCommand>>,
    pub host: String,
}

impl WsHandle {
    /// Send a command to the server
    pub fn send(&self, cmd: ClientCommand) -> Result<(), String> {
        web_sys::console::log_1(&format!("WsHandle::send to host '{}': {:?}", self.host, cmd).into());
        let envelope = WsEnvelope {
            id: uuid::Uuid::new_v4().to_string(),
            payload: cmd,
            ts: Utc::now(),
            correlation_id: None,
        };
        self.sender
            .unbounded_send(envelope)
            .map_err(|e| format!("Failed to send: {}", e))
    }

    /// Send a command with a correlation ID for tracking responses
    pub fn send_with_correlation(&self, cmd: ClientCommand, correlation_id: String) -> Result<(), String> {
        let envelope = WsEnvelope {
            id: uuid::Uuid::new_v4().to_string(),
            payload: cmd,
            ts: Utc::now(),
            correlation_id: Some(correlation_id),
        };
        self.sender
            .unbounded_send(envelope)
            .map_err(|e| format!("Failed to send: {}", e))
    }

    /// Subscribe to a channel
    pub fn subscribe(&self, channel_id: &str) -> Result<(), String> {
        self.send(ClientCommand::Subscribe {
            channel_id: channel_id.to_string(),
        })
    }

    /// Unsubscribe from a channel
    pub fn unsubscribe(&self, channel_id: &str) -> Result<(), String> {
        self.send(ClientCommand::Unsubscribe {
            channel_id: channel_id.to_string(),
        })
    }

    /// Send a message to a channel
    pub fn send_message(&self, channel_id: &str, body: &str, nonce: &str) -> Result<(), String> {
        self.send(ClientCommand::MessageCreate {
            channel_id: channel_id.to_string(),
            body: body.to_string(),
            nonce: nonce.to_string(),
        })
    }
}

/// A managed WebSocket connection to a single OFSCP provider
pub struct WsConnection {
    /// The host this connection is for (normalized, e.g. "example.com:8080")
    pub host: String,
    /// Current connection state
    pub state: Signal<ConnectionState>,
    /// Channel for sending commands
    sender: UnboundedSender<WsEnvelope<ClientCommand>>,
    /// Reconnect configuration
    reconnect_config: ReconnectConfig,
    /// URL builder function (called on each reconnect attempt)
    url_builder: std::rc::Rc<dyn Fn() -> Option<String>>,
    /// Event callback
    on_event: std::rc::Rc<dyn Fn(WsEnvelope<ServerEvent>)>,
}

impl WsConnection {
    /// Create a new WebSocket connection
    pub fn new(
        host: String,
        url_builder: impl Fn() -> Option<String> + 'static,
        on_event: impl Fn(WsEnvelope<ServerEvent>) + 'static,
    ) -> Self {
        let (sender, receiver) = unbounded();
        let state = Signal::new(ConnectionState::Disconnected);
        let reconnect_config = ReconnectConfig::default();

        let connection = Self {
            host: host.clone(),
            state,
            sender,
            reconnect_config,
            url_builder: std::rc::Rc::new(url_builder),
            on_event: std::rc::Rc::new(on_event),
        };

        // Start connection loop
        connection.start_connection_loop(receiver);

        connection
    }

    /// Get a handle for sending commands
    pub fn handle(&self) -> WsHandle {
        WsHandle {
            sender: self.sender.clone(),
            host: self.host.clone(),
        }
    }

    /// Start the connection management loop
    fn start_connection_loop(&self, receiver: UnboundedReceiver<WsEnvelope<ClientCommand>>) {
        use std::cell::RefCell;
        use std::rc::Rc;

        let host = self.host.clone();
        let mut state = self.state;
        let url_builder = self.url_builder.clone();
        let on_event = self.on_event.clone();
        let reconnect_config = self.reconnect_config.clone();

        // Wrap receiver in Rc<RefCell> so the send task can access it
        let receiver = Rc::new(RefCell::new(receiver));

        spawn_local(async move {
            let mut attempt = 0u32;

            loop {
                // Build URL
                let Some(url) = url_builder() else {
                    // No URL available (probably not authenticated)
                    state.set(ConnectionState::Disconnected);
                    // Wait a bit and try again
                    gloo_timers::future::TimeoutFuture::new(1000).await;
                    continue;
                };

                if attempt == 0 {
                    state.set(ConnectionState::Connecting);
                } else {
                    state.set(ConnectionState::Reconnecting { attempt });
                }

                // Attempt connection
                match connect_websocket(&url, on_event.clone()).await {
                    Ok(ws) => {
                        state.set(ConnectionState::Connected);
                        attempt = 0;
                        web_sys::console::log_1(&format!("WebSocket connected to {}", host).into());

                        // Channel to signal when connection closes
                        let (close_tx, mut close_rx) = futures_channel::mpsc::unbounded::<()>();

                        // Set up close handler
                        let onclose_callback = Closure::wrap(Box::new(move |_: web_sys::CloseEvent| {
                            let _ = close_tx.unbounded_send(());
                        }) as Box<dyn FnMut(web_sys::CloseEvent)>);
                        ws.set_onclose(Some(onclose_callback.as_ref().unchecked_ref()));
                        onclose_callback.forget();

                        // Spawn send task that awaits on the receiver
                        let ws_for_send = ws.clone();
                        let receiver_for_send = receiver.clone();
                        let host_for_send = host.clone();
                        spawn_local(async move {
                            loop {
                                // Take receiver, await next message, put it back
                                let msg = {
                                    let mut rx = receiver_for_send.borrow_mut();
                                    rx.next().await
                                };

                                match msg {
                                    Some(cmd) => {
                                        // Check if socket is still open (readyState 1 = OPEN)
                                        if ws_for_send.ready_state() != 1 {
                                            web_sys::console::log_1(&"WebSocket no longer open, stopping send task".into());
                                            break;
                                        }
                                        match serde_json::to_string(&cmd) {
                                            Ok(json) => {
                                                web_sys::console::log_1(&format!("Sending to {}: {}", host_for_send, json).into());
                                                if let Err(e) = ws_for_send.send_with_str(&json) {
                                                    web_sys::console::error_1(&format!("Send failed: {:?}", e).into());
                                                }
                                            }
                                            Err(e) => {
                                                web_sys::console::error_1(&format!("Serialize failed: {}", e).into());
                                            }
                                        }
                                    }
                                    None => {
                                        // Sender dropped
                                        web_sys::console::log_1(&"Sender dropped, stopping send task".into());
                                        break;
                                    }
                                }
                            }
                        });

                        // Wait for connection to close
                        close_rx.next().await;
                        web_sys::console::log_1(&format!("WebSocket to {} closed", host).into());
                        state.set(ConnectionState::Disconnected);
                    }
                    Err(e) => {
                        web_sys::console::error_1(
                            &format!("WebSocket error for {}: {}", host, e).into(),
                        );

                        // Check if we should retry
                        if reconnect_config.max_attempts > 0
                            && attempt >= reconnect_config.max_attempts
                        {
                            state.set(ConnectionState::Failed {
                                reason: format!("Max reconnect attempts ({}) exceeded", reconnect_config.max_attempts),
                            });
                            break;
                        }

                        // Wait before reconnecting
                        let delay = reconnect_config.delay_for_attempt(attempt);
                        web_sys::console::log_1(
                            &format!(
                                "Reconnecting to {} in {}ms (attempt {})",
                                host,
                                delay,
                                attempt + 1
                            )
                            .into(),
                        );
                        gloo_timers::future::TimeoutFuture::new(delay).await;
                        attempt += 1;
                    }
                }
            }
        });
    }
}

/// Internal function to establish a WebSocket connection and return it
/// The caller is responsible for handling the send/receive loop
async fn connect_websocket(
    url: &str,
    on_event: std::rc::Rc<dyn Fn(WsEnvelope<ServerEvent>)>,
) -> Result<web_sys::WebSocket, String> {
    use std::cell::RefCell;
    use std::rc::Rc;
    use web_sys::{CloseEvent, MessageEvent, WebSocket};

    let ws = WebSocket::new(url).map_err(|e| format!("Failed to create WebSocket: {:?}", e))?;

    // Track connection state
    let is_open = Rc::new(RefCell::new(false));
    let error_reason = Rc::new(RefCell::new(None::<String>));

    // Set up open handler
    let is_open_clone = is_open.clone();
    let onopen_callback = Closure::wrap(Box::new(move |_: web_sys::Event| {
        web_sys::console::log_1(&"WebSocket onopen fired".into());
        *is_open_clone.borrow_mut() = true;
    }) as Box<dyn FnMut(web_sys::Event)>);
    ws.set_onopen(Some(onopen_callback.as_ref().unchecked_ref()));
    onopen_callback.forget();

    // Set up close handler
    let error_reason_close = error_reason.clone();
    let onclose_callback = Closure::wrap(Box::new(move |e: CloseEvent| {
        let reason = if e.reason().is_empty() {
            format!("Code {}", e.code())
        } else {
            e.reason()
        };
        web_sys::console::log_1(&format!("WebSocket onclose: {}", reason).into());
        *error_reason_close.borrow_mut() = Some(reason);
    }) as Box<dyn FnMut(CloseEvent)>);
    ws.set_onclose(Some(onclose_callback.as_ref().unchecked_ref()));
    onclose_callback.forget();

    // Set up error handler
    let error_reason_err = error_reason.clone();
    let onerror_callback = Closure::wrap(Box::new(move |_: web_sys::ErrorEvent| {
        web_sys::console::error_1(&"WebSocket onerror fired".into());
        *error_reason_err.borrow_mut() = Some("WebSocket error".to_string());
    }) as Box<dyn FnMut(web_sys::ErrorEvent)>);
    ws.set_onerror(Some(onerror_callback.as_ref().unchecked_ref()));
    onerror_callback.forget();

    // Set up message handler
    let onmessage_callback = Closure::wrap(Box::new(move |e: MessageEvent| {
        if let Ok(text) = e.data().dyn_into::<js_sys::JsString>() {
            let text: String = text.into();
            web_sys::console::log_1(&format!("WebSocket received: {}", text).into());
            if let Ok(event) = serde_json::from_str::<WsEnvelope<ServerEvent>>(&text) {
                on_event(event);
            }
        }
    }) as Box<dyn FnMut(MessageEvent)>);
    ws.set_onmessage(Some(onmessage_callback.as_ref().unchecked_ref()));
    onmessage_callback.forget();

    // Wait for connection to open
    for _ in 0..500 {
        // 5 second timeout
        if *is_open.borrow() {
            web_sys::console::log_1(&"WebSocket connected, ready to send/receive".into());
            return Ok(ws);
        }
        if let Some(reason) = error_reason.borrow().clone() {
            return Err(reason);
        }
        // Yield to allow callbacks to fire
        gloo_timers::future::TimeoutFuture::new(10).await;
    }

    Err("Connection timeout".to_string())
}
