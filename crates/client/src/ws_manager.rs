//! WebSocket connection manager for real-time messaging.
//!
//! This module manages WebSocket connections to OFSCP providers.
//! Unlike the previous fullstack approach, this connects directly
//! to the server's WebSocket endpoint.

use dioxus::prelude::*;
use forumall_shared::{ClientCommand, ServerEvent, WsEnvelope};
use futures_channel::mpsc::{unbounded, UnboundedSender};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::Arc;
use wasm_bindgen::prelude::*;
use web_sys::js_sys;
use wasm_bindgen_futures::spawn_local;

use crate::auth_session::AuthContext;
use crate::client_keys::sign_ws_request;

/// WebSocket connection handle
pub struct WsConnection {
    sender: UnboundedSender<WsEnvelope<ClientCommand>>,
}

impl WsConnection {
    /// Send a command to the server
    pub async fn send(&self, msg: WsEnvelope<ClientCommand>) -> Result<(), String> {
        self.sender
            .unbounded_send(msg)
            .map_err(|e| format!("Failed to send: {}", e))
    }
}

/// Global WebSocket connections map
pub static WS_MANAGER: GlobalSignal<HashMap<String, Arc<WsConnection>>> = Signal::global(HashMap::new);

/// Hosts that need WebSocket connections
pub static WS_HOSTS: GlobalSignal<Vec<String>> = Signal::global(Vec::new);

/// Incoming server events (for components to subscribe to)
pub static WS_EVENTS: GlobalSignal<Vec<WsEnvelope<ServerEvent>>> = Signal::global(Vec::new);

/// Normalize a host string for use as a key
pub fn normalize_host(host: &str) -> String {
    host.trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/')
        .to_string()
}

/// Clear all WebSocket connections (used during logout)
pub fn clear_connections() {
    WS_HOSTS.write().clear();
    WS_MANAGER.write().clear();
    WS_EVENTS.write().clear();
}

/// Request a WebSocket connection to a host
pub fn request_connection(host: &str) {
    let normalized = normalize_host(host);
    let mut hosts = WS_HOSTS.write();
    if !hosts.contains(&normalized) {
        hosts.push(normalized);
    }
}

/// Component that manages WebSocket connections
#[component]
pub fn WsManager(children: Element) -> Element {
    let auth = use_context::<AuthContext>();

    // Effect to establish connections when hosts are added
    use_effect(move || {
        let hosts = WS_HOSTS.read().clone();
        let session = auth.session.read().clone();

        for host in hosts {
            // Skip if already connected
            if WS_MANAGER.read().contains_key(&host) {
                continue;
            }

            // Need auth to connect
            let Some(sess) = session.as_ref() else {
                continue;
            };

            let Some(keys) = sess.keys.as_ref() else {
                continue;
            };

            // Build WebSocket URL
            let domain = auth.provider_domain.read().clone();
            let ws_path = "/api/ws";

            // Sign the WebSocket request
            let Some(auth_params) = sign_ws_request(ws_path, keys, &sess.user_id, &domain) else {
                continue;
            };

            let ws_url = format!(
                "{}?{}",
                auth.ws_url(ws_path),
                auth_params.to_query_string()
            );

            let host_clone = host.clone();

            // Spawn connection task
            spawn_local(async move {
                if let Err(e) = connect_websocket(&host_clone, &ws_url).await {
                    web_sys::console::error_1(&format!("WebSocket error for {}: {}", host_clone, e).into());
                }
            });
        }
    });

    children
}

/// Connect to a WebSocket endpoint
async fn connect_websocket(host: &str, url: &str) -> Result<(), String> {
    use web_sys::{MessageEvent, WebSocket};

    let ws = WebSocket::new(url).map_err(|e| format!("Failed to create WebSocket: {:?}", e))?;

    let (tx, mut rx) = unbounded::<WsEnvelope<ClientCommand>>();

    let connection = Arc::new(WsConnection { sender: tx });

    // Store connection
    WS_MANAGER.write().insert(host.to_string(), connection);

    // Set up message handler
    let onmessage_callback = Closure::wrap(Box::new(move |e: MessageEvent| {
        if let Ok(text) = e.data().dyn_into::<js_sys::JsString>() {
            let text: String = text.into();
            if let Ok(event) = serde_json::from_str::<WsEnvelope<ServerEvent>>(&text) {
                WS_EVENTS.write().push(event);
            }
        }
    }) as Box<dyn FnMut(MessageEvent)>);

    ws.set_onmessage(Some(onmessage_callback.as_ref().unchecked_ref()));
    onmessage_callback.forget();

    // Handle outgoing messages
    let ws_clone = ws.clone();
    spawn_local(async move {
        while let Some(msg) = rx.next().await {
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = ws_clone.send_with_str(&json);
            }
        }
    });

    Ok(())
}
