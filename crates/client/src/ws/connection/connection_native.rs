//! Native/Desktop WebSocket implementation using tokio-tungstenite.

use dioxus::prelude::*;
use forumall_shared::{ClientCommand, ServerEvent, WsEnvelope};
use futures_channel::mpsc::{unbounded, UnboundedReceiver, UnboundedSender};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use super::{ConnectionState, ReconnectConfig, WsHandle};

/// A managed WebSocket connection to a single OFSCP provider (Native implementation)
pub struct WsConnection {
    /// The host this connection is for (normalized, e.g. "example.com:8080")
    pub host: String,
    /// Current connection state
    pub state: Signal<ConnectionState>,
    /// Channel for sending commands
    sender: UnboundedSender<WsEnvelope<ClientCommand>>,
    /// Reconnect configuration
    #[allow(dead_code)]
    reconnect_config: ReconnectConfig,
    /// URL builder function (called on each reconnect attempt)
    #[allow(dead_code)]
    url_builder: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// Event callback
    #[allow(dead_code)]
    on_event: Arc<dyn Fn(WsEnvelope<ServerEvent>) + Send + Sync>,
}

impl WsConnection {
    /// Create a new WebSocket connection
    pub fn new(
        host: String,
        url_builder: impl Fn() -> Option<String> + Send + Sync + 'static,
        on_event: impl Fn(WsEnvelope<ServerEvent>) + Send + Sync + 'static,
    ) -> Self {
        let (sender, receiver) = unbounded();
        let state = Signal::new(ConnectionState::Disconnected);
        let reconnect_config = ReconnectConfig::default();

        let url_builder = Arc::new(url_builder);
        let on_event = Arc::new(on_event);

        let connection = Self {
            host: host.clone(),
            state,
            sender,
            reconnect_config: reconnect_config.clone(),
            url_builder: url_builder.clone(),
            on_event: on_event.clone(),
        };

        // Start connection loop in a background task
        start_connection_loop(
            host,
            state,
            receiver,
            url_builder,
            on_event,
            reconnect_config,
        );

        connection
    }

    /// Get a handle for sending commands
    pub fn handle(&self) -> WsHandle {
        WsHandle::new(self.sender.clone(), self.host.clone())
    }
}

/// Start the connection management loop in a background tokio task
fn start_connection_loop(
    host: String,
    mut state: Signal<ConnectionState>,
    receiver: UnboundedReceiver<WsEnvelope<ClientCommand>>,
    url_builder: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    on_event: Arc<dyn Fn(WsEnvelope<ServerEvent>) + Send + Sync>,
    reconnect_config: ReconnectConfig,
) {
    // Use tokio's current runtime or spawn a new one
    tokio::spawn(async move {
        // Wrap receiver in a mutex for sharing between tasks
        let receiver = std::sync::Arc::new(tokio::sync::Mutex::new(receiver));
        let mut attempt = 0u32;

        loop {
            // Build URL
            let Some(url) = url_builder() else {
                // No URL available (probably not authenticated)
                state.set(ConnectionState::Disconnected);
                // Wait a bit and try again
                tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
                continue;
            };

            if attempt == 0 {
                state.set(ConnectionState::Connecting);
            } else {
                state.set(ConnectionState::Reconnecting { attempt });
            }

            // Attempt connection
            match connect_async(&url).await {
                Ok((ws_stream, _response)) => {
                    state.set(ConnectionState::Connected);
                    attempt = 0;
                    crate::log_info!("WebSocket connected to {}", host);

                    let (mut write, mut read) = ws_stream.split();

                    // Channel to signal when connection closes
                    let (close_tx, mut close_rx) = tokio::sync::mpsc::unbounded_channel::<()>();

                    // Spawn read task
                    let host_for_read = host.clone();
                    let on_event_clone = on_event.clone();
                    let close_tx_for_read = close_tx.clone();
                    tokio::spawn(async move {
                        while let Some(msg_result) = read.next().await {
                            match msg_result {
                                Ok(Message::Text(text)) => {
                                    crate::log_info!("WebSocket received: {}", text);
                                    match serde_json::from_str::<WsEnvelope<ServerEvent>>(&text) {
                                        Ok(event) => on_event_clone(event),
                                        Err(e) => {
                                            crate::log_error!("Failed to parse message: {}", e)
                                        }
                                    }
                                }
                                Ok(Message::Close(_)) => {
                                    crate::log_info!(
                                        "WebSocket to {} received close frame",
                                        host_for_read
                                    );
                                    break;
                                }
                                Ok(Message::Ping(data)) => {
                                    // Pong is handled automatically by tungstenite
                                    crate::log_debug!("Received ping: {:?}", data);
                                }
                                Ok(_) => {
                                    // Ignore binary, pong, etc.
                                }
                                Err(e) => {
                                    crate::log_error!("WebSocket read error: {}", e);
                                    break;
                                }
                            }
                        }
                        let _ = close_tx_for_read.send(());
                    });

                    // Spawn write task
                    let receiver_for_write = receiver.clone();
                    let host_for_write = host.clone();
                    tokio::spawn(async move {
                        loop {
                            let msg = {
                                let mut rx = receiver_for_write.lock().await;
                                rx.next().await
                            };

                            match msg {
                                Some(cmd) => match serde_json::to_string(&cmd) {
                                    Ok(json) => {
                                        crate::log_info!("Sending to {}: {}", host_for_write, json);
                                        if let Err(e) = write.send(Message::Text(json)).await {
                                            crate::log_error!("Send failed: {}", e);
                                            break;
                                        }
                                    }
                                    Err(e) => {
                                        crate::log_error!("Serialize failed: {}", e);
                                    }
                                },
                                None => {
                                    // Sender dropped
                                    crate::log_info!("Sender dropped, stopping write task");
                                    break;
                                }
                            }
                        }
                        let _ = close_tx.send(());
                    });

                    // Wait for connection to close
                    close_rx.recv().await;
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
                    tokio::time::sleep(tokio::time::Duration::from_millis(delay as u64)).await;
                    attempt += 1;
                }
            }
        }
    });
}
