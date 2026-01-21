//! WebSocket module for real-time communication with OFSCP providers.
//!
//! This module provides:
//! - Connection management with auto-reconnect
//! - Multi-provider support (for OFSCP federation)
//! - React-style hooks for easy component integration
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
//!                  WS_EVENTS (global)
//!                         │
//!          ┌──────────────┼──────────────┐
//!          ▼              ▼              ▼
//!   ┌────────────┐ ┌────────────┐ ┌────────────┐
//!   │ Component  │ │ Component  │ │ Component  │
//!   │(use_channel│ │(use_ws_    │ │(use_ws_    │
//!   │ _messages) │ │ events)    │ │ handle)    │
//!   └────────────┘ └────────────┘ └────────────┘
//! ```
//!
//! # Usage
//!
//! ```rust,ignore
//! // In your app root, wrap with WsManager
//! rsx! {
//!     WsManager {
//!         // Your app here
//!     }
//! }
//!
//! // In a component that needs channel messages
//! fn MyChannel(channel_id: Signal<String>) -> Element {
//!     let (messages, send) = use_channel_messages(
//!         use_signal(|| String::new()), // local provider
//!         channel_id,
//!     );
//!
//!     rsx! {
//!         for msg in messages.read().iter() {
//!             div { "{msg.content.text}" }
//!         }
//!         button {
//!             onclick: move |_| send("Hello!".to_string()),
//!             "Send"
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

// Re-export hooks
pub use hooks::{
    use_channel_messages, use_connection_state, use_consume_events, use_ws_events, use_ws_handle,
};
