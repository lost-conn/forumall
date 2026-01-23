//! WASM/Web-specific WebSocket implementation using web_sys::WebSocket.

use dioxus::prelude::*;
use forumall_shared::{ClientCommand, ServerEvent, WsEnvelope};
use futures_channel::mpsc::{unbounded, UnboundedReceiver};
use futures_util::StreamExt;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;
use web_sys::js_sys;

use super::{ConnectionState, ReconnectConfig, WsHandle};

/// A managed WebSocket connection to a single OFSCP provider (WASM implementation)
pub struct WsConnection {
    /// The host this connection is for (normalized, e.g. "example.com:8080")
    pub host: String,
    /// Current connection state
    pub state: Signal<ConnectionState>,
    /// Channel for sending commands
    sender: futures_channel::mpsc::UnboundedSender<WsEnvelope<ClientCommand>>,
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
        WsHandle::new(self.sender.clone(), self.host.clone())
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
                        crate::log_info!("WebSocket connected to {}", host);

                        // Channel to signal when connection closes
                        let (close_tx, mut close_rx) = futures_channel::mpsc::unbounded::<()>();

                        // Set up close handler
                        let onclose_callback =
                            Closure::wrap(Box::new(move |_: web_sys::CloseEvent| {
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
                                            crate::log_info!(
                                                "WebSocket no longer open, stopping send task"
                                            );
                                            break;
                                        }
                                        match serde_json::to_string(&cmd) {
                                            Ok(json) => {
                                                crate::log_info!(
                                                    "Sending to {}: {}",
                                                    host_for_send,
                                                    json
                                                );
                                                if let Err(e) = ws_for_send.send_with_str(&json) {
                                                    crate::log_error!("Send failed: {:?}", e);
                                                }
                                            }
                                            Err(e) => {
                                                crate::log_error!("Serialize failed: {}", e);
                                            }
                                        }
                                    }
                                    None => {
                                        // Sender dropped
                                        crate::log_info!("Sender dropped, stopping send task");
                                        break;
                                    }
                                }
                            }
                        });

                        // Wait for connection to close
                        close_rx.next().await;
                        crate::log_info!("WebSocket to {} closed", host);
                        state.set(ConnectionState::Disconnected);
                    }
                    Err(e) => {
                        crate::log_error!("WebSocket error for {}: {}", host, e);

                        // Check if we should retry
                        if reconnect_config.max_attempts > 0
                            && attempt >= reconnect_config.max_attempts
                        {
                            state.set(ConnectionState::Failed {
                                reason: format!(
                                    "Max reconnect attempts ({}) exceeded",
                                    reconnect_config.max_attempts
                                ),
                            });
                            break;
                        }

                        // Wait before reconnecting
                        let delay = reconnect_config.delay_for_attempt(attempt);
                        crate::log_info!(
                            "Reconnecting to {} in {}ms (attempt {})",
                            host,
                            delay,
                            attempt + 1
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
        crate::log_info!("WebSocket onopen fired");
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
        crate::log_info!("WebSocket onclose: {}", reason);
        *error_reason_close.borrow_mut() = Some(reason);
    }) as Box<dyn FnMut(CloseEvent)>);
    ws.set_onclose(Some(onclose_callback.as_ref().unchecked_ref()));
    onclose_callback.forget();

    // Set up error handler
    let error_reason_err = error_reason.clone();
    let onerror_callback = Closure::wrap(Box::new(move |_: web_sys::ErrorEvent| {
        crate::log_error!("WebSocket onerror fired");
        *error_reason_err.borrow_mut() = Some("WebSocket error".to_string());
    }) as Box<dyn FnMut(web_sys::ErrorEvent)>);
    ws.set_onerror(Some(onerror_callback.as_ref().unchecked_ref()));
    onerror_callback.forget();

    // Set up message handler
    let onmessage_callback = Closure::wrap(Box::new(move |e: MessageEvent| {
        if let Ok(text) = e.data().dyn_into::<js_sys::JsString>() {
            let text: String = text.into();
            crate::log_info!("WebSocket received: {}", text);
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
            crate::log_info!("WebSocket connected, ready to send/receive");
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
