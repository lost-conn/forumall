//! WebSocket connection manager for multiple OFSCP providers.

use std::collections::HashMap;
use std::rc::Rc;

use dioxus::prelude::*;
use forumall_shared::{BaseMessage, ServerEvent, WsEnvelope};

use super::connection::{ConnectionState, WsConnection, WsHandle};
use crate::auth_session::AuthContext;
use crate::client_keys::sign_ws_request;

/// Normalize a host string for use as a key (strips protocol prefix)
pub fn normalize_host(host: &str) -> String {
    host.trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/')
        .to_string()
}

/// Event types that can be dispatched to listeners
#[derive(Debug, Clone)]
pub enum WsEvent {
    /// A new message was received
    NewMessage {
        host: String,
        message: BaseMessage,
    },
    /// Message send acknowledged
    Ack {
        host: String,
        nonce: String,
        message_id: String,
    },
    /// An error occurred
    Error {
        host: String,
        code: String,
        message: String,
        correlation_id: Option<String>,
    },
    /// Connection state changed
    ConnectionStateChanged {
        host: String,
        state: ConnectionState,
    },
}

/// Global signal for incoming WebSocket events
pub static WS_EVENTS: GlobalSignal<Vec<WsEvent>> = Signal::global(Vec::new);

/// Global signal for hosts that need WebSocket connections
pub static WS_HOSTS: GlobalSignal<Vec<String>> = Signal::global(Vec::new);

/// Global map of connection handles
pub static WS_HANDLES: GlobalSignal<HashMap<String, WsHandle>> = Signal::global(HashMap::new);

/// Global map of connection states
pub static WS_STATES: GlobalSignal<HashMap<String, ConnectionState>> = Signal::global(HashMap::new);

/// Request a WebSocket connection to a host
pub fn request_connection(host: &str) {
    let normalized = normalize_host(host);
    let mut hosts = WS_HOSTS.write();
    if !hosts.contains(&normalized) {
        hosts.push(normalized);
    }
}

/// Clear all WebSocket connections (used during logout)
pub fn clear_connections() {
    WS_HOSTS.write().clear();
    WS_HANDLES.write().clear();
    WS_STATES.write().clear();
    WS_EVENTS.write().clear();
}

/// Get a connection handle for a specific host
pub fn get_handle(host: &str) -> Option<WsHandle> {
    let normalized = normalize_host(host);
    let handles = WS_HANDLES.read();
    let available_keys: Vec<_> = handles.keys().collect();
    crate::log_info!("get_handle: looking for '{}' (normalized: '{}'), available: {:?}", host, normalized, available_keys);
    handles.get(&normalized).cloned()
}

/// Get the connection state for a specific host
pub fn get_state(host: &str) -> ConnectionState {
    let normalized = normalize_host(host);
    WS_STATES
        .read()
        .get(&normalized)
        .cloned()
        .unwrap_or(ConnectionState::Disconnected)
}

/// Check if connected to a specific host
pub fn is_connected(host: &str) -> bool {
    get_state(host).is_connected()
}

/// Component that manages WebSocket connections for all providers
#[component]
pub fn WsManager(children: Element) -> Element {
    let auth = use_context::<AuthContext>();

    // Track active connections to avoid re-creating
    let mut active_connections = use_signal(|| HashMap::<String, Rc<WsConnection>>::new());

    // Effect to establish connections when hosts are added
    use_effect(move || {
        let hosts = WS_HOSTS.read().clone();
        let session = auth.session.read().clone();

        for raw_host in hosts {
            // Normalize the host for consistent key lookup
            let host = normalize_host(&raw_host);

            // Skip if already connected
            if active_connections.read().contains_key(&host) {
                continue;
            }

            // Need auth to connect
            let Some(sess) = session.as_ref() else {
                continue;
            };

            let Some(keys) = sess.keys.as_ref() else {
                continue;
            };

            // Clone what we need for the closures
            let host_for_url = host.clone();
            let host_for_event = host.clone();
            let domain = auth.provider_domain.read().clone();
            let user_id = sess.user_id.clone();
            let keys_clone = keys.clone();
            let auth_clone = auth.clone();

            // URL builder closure (called on each reconnect)
            // Uses the host to connect to the correct provider's WebSocket
            let url_builder = move || {
                let ws_path = "/api/ws";

                // Sign the WebSocket request
                let auth_params = sign_ws_request(ws_path, &keys_clone, &user_id, &domain)?;

                // Build WebSocket URL for the specific host
                // Empty host means local provider, otherwise connect to remote provider
                let host_option = if host_for_url.is_empty() {
                    None
                } else {
                    Some(host_for_url.as_str())
                };

                let ws_url = format!(
                    "{}?{}",
                    auth_clone.ws_url_for_host(host_option, ws_path),
                    auth_params.to_query_string()
                );

                Some(ws_url)
            };

            // Event handler closure
            let on_event = move |envelope: WsEnvelope<ServerEvent>| {
                let event = match envelope.payload {
                    ServerEvent::MessageNew { message } => WsEvent::NewMessage {
                        host: host_for_event.clone(),
                        message,
                    },
                    ServerEvent::Ack { nonce, message_id } => WsEvent::Ack {
                        host: host_for_event.clone(),
                        nonce,
                        message_id,
                    },
                    ServerEvent::Error {
                        code,
                        message,
                        correlation_id,
                    } => WsEvent::Error {
                        host: host_for_event.clone(),
                        code,
                        message,
                        correlation_id,
                    },
                };

                WS_EVENTS.write().push(event);
            };

            // Create the connection
            let connection = WsConnection::new(host.clone(), url_builder, on_event);

            // Store the handle
            WS_HANDLES.write().insert(host.clone(), connection.handle());

            // Store the connection
            active_connections
                .write()
                .insert(host.clone(), Rc::new(connection));

            crate::log_info!("Created WebSocket connection for: {}", host);
        }
    });

    // Effect to track connection states
    use_effect(move || {
        let connections = active_connections.read();
        let mut states = WS_STATES.write();

        for (host, conn) in connections.iter() {
            let state = conn.state.read().clone();
            states.insert(host.clone(), state);
        }
    });

    children
}
