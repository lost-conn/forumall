//! WebSocket connection manager for multiple OFSCP providers.

use std::collections::HashMap;
use std::rc::Rc;

use dioxus::prelude::*;
use forumall_shared::{BaseMessage, Presence, ServerEvent, UserRef, WsEnvelope};

use super::connection::{ConnectionState, WsConnection, WsHandle};
use crate::auth_session::AuthContext;
use crate::client_keys::sign_ws_request;
use crate::stores::{update_user_presence, ChannelMessages, StoredMessage, MESSAGES};

/// Normalize a host string for use as a key (strips protocol prefix)
pub fn normalize_host(host: &str) -> String {
    host.trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/')
        .to_string()
}

/// Extract user ID from UserRef, preserving the domain
fn extract_user_id(user_ref: &UserRef) -> String {
    match user_ref {
        // Handle format is now "handle@domain" - return as-is
        UserRef::Handle(h) => h.to_string(),
        // URI format: "ofscp://domain/users/handle" - extract handle@domain
        UserRef::Uri(u) => {
            if let Some(rest) = u.strip_prefix("ofscp://") {
                if let Some(idx) = rest.find("/users/") {
                    let domain = &rest[..idx];
                    let handle = &rest[idx + 7..];
                    return format!("{}@{}", handle, domain);
                }
            }
            // Fallback: just return the URI as-is
            u.to_string()
        }
    }
}

/// Event types that can be dispatched to listeners
#[derive(Debug, Clone)]
pub enum WsEvent {
    /// A new message was received
    NewMessage {
        host: String,
        channel_id: String,
        message: BaseMessage,
    },
    /// Presence update received
    PresenceUpdate {
        host: String,
        user_handle: String,
        user_domain: String,
        presence: Presence,
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

    // Track the current user_id to detect session changes
    let mut last_user_id = use_signal(|| None::<String>);

    // Effect to establish connections when hosts are added
    use_effect(move || {
        let hosts = WS_HOSTS.read().clone();
        let session = auth.session.read().clone();

        // Get current user_id
        let current_user_id = session.as_ref().map(|s| s.user_id.clone());

        // If session changed (different user or logged out), clear old connections
        if *last_user_id.read() != current_user_id {
            crate::log_info!("WsManager: session changed, clearing old connections");
            active_connections.write().clear();
            last_user_id.set(current_user_id.clone());
        }

        crate::log_info!("WsManager: effect running with hosts: {:?}", hosts);

        for raw_host in hosts {
            // Normalize the host for consistent key lookup
            let host = normalize_host(&raw_host);

            // Skip if already connected
            if active_connections.read().contains_key(&host) {
                crate::log_info!("WsManager: already connected to host: {}", host);
                continue;
            }

            crate::log_info!("WsManager: creating connection to host: {}", host);

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
            let user_id_for_event = user_id.clone();
            // Extract just the handle from user_id (format: "handle@domain" or just "handle")
            let handle = user_id.split('@').next().unwrap_or(&user_id).to_string();
            let keys_clone = keys.clone();
            let auth_clone = auth.clone();

            // URL builder closure (called on each reconnect)
            // Uses the host to connect to the correct provider's WebSocket
            let url_builder = move || {
                let ws_path = "/api/ws";

                // Sign the WebSocket request
                let auth_params = sign_ws_request(ws_path, &keys_clone, &handle, &domain)?;

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
                    ServerEvent::MessageNew { channel_id, message } => {
                        // Convert BaseMessage to StoredMessage and add directly to store
                        let stored = StoredMessage {
                            id: message.id.clone(),
                            user_id: extract_user_id(&message.author),
                            title: message.title.clone(),
                            content: message.content.text.clone(),
                            message_type: message.r#type.clone(),
                            created_at: message.created_at,
                        };

                        // Play notification sound for new messages from other users
                        let is_own_message = stored.user_id == user_id_for_event;

                        // Add to message store
                        let mut store = MESSAGES.resolve();
                        store
                            .write()
                            .entry(channel_id.clone())
                            .or_insert_with(ChannelMessages::default)
                            .add_message(stored);

                        if !is_own_message {
                            crate::audio::play_notification();
                        }

                        WsEvent::NewMessage {
                            host: host_for_event.clone(),
                            channel_id,
                            message,
                        }
                    }
                    ServerEvent::PresenceUpdate {
                        user_handle,
                        user_domain,
                        presence,
                    } => {
                        // Update presence store
                        update_user_presence(&user_handle, &user_domain, presence.clone());

                        WsEvent::PresenceUpdate {
                            host: host_for_event.clone(),
                            user_handle,
                            user_domain,
                            presence,
                        }
                    }
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
