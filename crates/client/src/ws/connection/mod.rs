//! WebSocket connection with state management and auto-reconnect.
//!
//! This module provides the shared types and conditionally includes
//! the platform-specific implementation.

use chrono::Utc;
use dioxus::prelude::*;
use forumall_shared::{ClientCommand, WsEnvelope};
use futures_channel::mpsc::UnboundedSender;

/// Connection state for a WebSocket
#[derive(Debug, Clone, PartialEq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting { attempt: u32 },
    Failed { reason: String },
}

impl ConnectionState {
    pub fn is_connected(&self) -> bool {
        matches!(self, ConnectionState::Connected)
    }

    pub fn is_connecting(&self) -> bool {
        matches!(
            self,
            ConnectionState::Connecting | ConnectionState::Reconnecting { .. }
        )
    }
}

/// Configuration for auto-reconnect behavior
#[derive(Debug, Clone)]
pub struct ReconnectConfig {
    /// Maximum number of reconnect attempts (0 = infinite)
    pub max_attempts: u32,
    /// Initial delay in milliseconds
    pub initial_delay_ms: u32,
    /// Maximum delay in milliseconds
    pub max_delay_ms: u32,
    /// Multiplier for exponential backoff
    pub backoff_multiplier: f32,
}

impl Default for ReconnectConfig {
    fn default() -> Self {
        Self {
            max_attempts: 10,
            initial_delay_ms: 1000,
            max_delay_ms: 30000,
            backoff_multiplier: 1.5,
        }
    }
}

impl ReconnectConfig {
    /// Calculate delay for a given attempt number
    pub fn delay_for_attempt(&self, attempt: u32) -> u32 {
        let delay = self.initial_delay_ms as f32 * self.backoff_multiplier.powi(attempt as i32);
        (delay as u32).min(self.max_delay_ms)
    }
}

/// Handle for sending commands through a WebSocket connection
#[derive(Clone)]
pub struct WsHandle {
    sender: UnboundedSender<WsEnvelope<ClientCommand>>,
    pub host: String,
}

impl WsHandle {
    pub(crate) fn new(sender: UnboundedSender<WsEnvelope<ClientCommand>>, host: String) -> Self {
        Self { sender, host }
    }

    /// Send a command to the server
    pub fn send(&self, cmd: ClientCommand) -> Result<(), String> {
        crate::log_info!("WsHandle::send to host '{}': {:?}", self.host, cmd);
        let envelope = WsEnvelope {
            id: uuid::Uuid::new_v4().to_string(),
            payload: cmd,
            ts: Utc::now(),
            correlation_id: None,
        };
        self.sender
            .unbounded_send(envelope)
            .map_err(|e| format!("Failed to send: {}", e))
    }

    /// Send a command with a correlation ID for tracking responses
    pub fn send_with_correlation(
        &self,
        cmd: ClientCommand,
        correlation_id: String,
    ) -> Result<(), String> {
        let envelope = WsEnvelope {
            id: uuid::Uuid::new_v4().to_string(),
            payload: cmd,
            ts: Utc::now(),
            correlation_id: Some(correlation_id),
        };
        self.sender
            .unbounded_send(envelope)
            .map_err(|e| format!("Failed to send: {}", e))
    }

    /// Subscribe to a channel
    pub fn subscribe(&self, channel_id: &str) -> Result<(), String> {
        self.send(ClientCommand::Subscribe {
            channel_id: channel_id.to_string(),
        })
    }

    /// Unsubscribe from a channel
    pub fn unsubscribe(&self, channel_id: &str) -> Result<(), String> {
        self.send(ClientCommand::Unsubscribe {
            channel_id: channel_id.to_string(),
        })
    }

    /// Send a message to a channel
    pub fn send_message(&self, channel_id: &str, body: &str, nonce: &str) -> Result<(), String> {
        self.send(ClientCommand::MessageCreate {
            channel_id: channel_id.to_string(),
            body: body.to_string(),
            nonce: nonce.to_string(),
        })
    }
}

// Include platform-specific implementation
#[cfg(target_arch = "wasm32")]
mod connection_wasm;
#[cfg(target_arch = "wasm32")]
pub use connection_wasm::WsConnection;

#[cfg(not(target_arch = "wasm32"))]
mod connection_native;
#[cfg(not(target_arch = "wasm32"))]
pub use connection_native::WsConnection;
