//! WebSocket-related hooks for Dioxus components.
//!
//! NOTE: These hooks are kept minimal. Components should NOT read from WebSocket
//! events directly. Instead, WebSocket handlers write to global stores, and
//! components read from those stores reactively.

use dioxus::prelude::*;

use super::connection::ConnectionState;
use super::manager::{get_handle, WS_STATES};

/// Hook to get the connection state for a specific host.
///
/// # Arguments
/// * `host` - The provider host (e.g., "example.com" or empty for local)
///
/// # Returns
/// The current connection state (reactive - updates when state changes)
pub fn use_connection_state(host: &str) -> ConnectionState {
    let states = WS_STATES.read();
    states.get(host).cloned().unwrap_or(ConnectionState::Disconnected)
}

/// Hook to get a WebSocket handle for sending commands.
///
/// # Arguments
/// * `host` - The provider host (e.g., "example.com" or empty for local)
///
/// # Returns
/// An optional handle (None if not connected)
pub fn use_ws_handle(host: &str) -> Option<super::connection::WsHandle> {
    get_handle(host)
}
