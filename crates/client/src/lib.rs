//! Forumall Client - Dioxus application
//!
//! This crate contains the web/desktop client for forumall,
//! a Dioxus-based OFSCP chat application.
//!
//! # Platform Support
//!
//! - **Web (WASM)**: Uses `web_sys::WebSocket` and `localStorage`
//! - **Desktop (Native)**: Uses `tokio-tungstenite` and file-based config storage

// Cross-platform modules (must be declared first for macro availability)
#[macro_use]
pub mod logging;
pub mod storage;

pub mod api_client;
pub mod auth_session;
pub mod client_keys;
pub mod ws;

pub mod components;
pub mod hooks;
pub mod routes;
pub mod stores;
pub mod views;

pub use api_client::ApiClient;
pub use auth_session::{AuthContext, AuthProvider, AuthSession};
pub use client_keys::KeyPair;
pub use routes::Route;

// Re-export ws module for backwards compatibility
pub mod ws_manager {
    pub use crate::ws::*;
}
