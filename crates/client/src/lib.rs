//! Forumall Client - Dioxus web application
//!
//! This crate contains the web/desktop/mobile client for forumall,
//! a Dioxus-based OFSCP chat application.

pub mod api_client;
pub mod auth_session;
pub mod client_keys;
pub mod ws;

pub mod components;
pub mod hooks;
pub mod routes;
pub mod views;

pub use api_client::ApiClient;
pub use auth_session::{AuthContext, AuthProvider, AuthSession};
pub use client_keys::KeyPair;
pub use routes::Route;

// Re-export ws module for backwards compatibility
pub mod ws_manager {
    pub use crate::ws::*;
}
