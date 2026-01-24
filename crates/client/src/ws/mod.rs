//! WebSocket module for real-time communication with OFSCP providers.
//!
//! This module provides:
//! - Connection management with auto-reconnect
//! - Multi-provider support (for OFSCP federation)
//! - Direct writes to global stores (components read from stores, not events)
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────┐
//! │                    WsManager                        │
//! │  (Component that manages all WebSocket connections) │
//! └─────────────────────────────────────────────────────┘
//!                         │
//!          ┌──────────────┼──────────────┐
//!          ▼              ▼              ▼
//!   ┌────────────┐ ┌────────────┐ ┌────────────┐
//!   │WsConnection│ │WsConnection│ │WsConnection│
//!   │ (local)    │ │ (host A)   │ │ (host B)   │
//!   └────────────┘ └────────────┘ └────────────┘
//!          │              │              │
//!          └──────────────┼──────────────┘
//!                         ▼
//!              ┌─────────────────────┐
//!              │   Global Stores     │
//!              │  (e.g., MESSAGES)   │
//!              └─────────────────────┘
//!                         │
//!          ┌──────────────┼──────────────┐
//!          ▼              ▼              ▼
//!   ┌────────────┐ ┌────────────┐ ┌────────────┐
//!   │ Component  │ │ Component  │ │ Component  │
//!   │ (reads     │ │ (reads     │ │ (reads     │
//!   │  store)    │ │  store)    │ │  store)    │
//!   └────────────┘ └────────────┘ └────────────┘
//! ```
//!
//! # Usage
//!
//! Components should read from global stores (like `MESSAGES`), not from
//! WebSocket events directly. The WebSocket manager writes incoming messages
//! to the appropriate store automatically.
//!
//! ```rust,ignore
//! // In your app root, wrap with WsManager
//! rsx! {
//!     WsManager {
//!         // Your app here
//!     }
//! }
//!
//! // In a component, read from the message store
//! fn MyChannel(channel_id: String) -> Element {
//!     let store = MESSAGES.resolve();
//!     let messages = store.read().get(&channel_id);
//!
//!     rsx! {
//!         if let Some(ch) = messages {
//!             for msg in ch.messages.iter() {
//!                 div { "{msg.content}" }
//!             }
//!         }
//!     }
//! }
//! ```

mod connection;
mod hooks;
mod manager;

// Re-export connection types
pub use connection::{ConnectionState, ReconnectConfig, WsConnection, WsHandle};

// Re-export manager types and functions
pub use manager::{
    clear_connections, get_handle, get_state, is_connected, normalize_host, request_connection,
    WsEvent, WsManager, WS_EVENTS, WS_HANDLES, WS_HOSTS, WS_STATES,
};

// Re-export hooks (minimal - most data comes from stores)
pub use hooks::{use_connection_state, use_ws_handle};
