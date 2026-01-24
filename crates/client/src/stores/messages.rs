//! Global message store for managing channel messages.
//!
//! This store provides a single source of truth for all messages across channels.
//! Messages are organized by channel_id, and each channel tracks whether its
//! history has been loaded from the REST API.

use chrono::{DateTime, Utc};
use dioxus::prelude::*;
use forumall_shared::MessageType;
use std::collections::HashMap;

/// A message stored in the global message store.
/// This is a unified format that works for both REST API and WebSocket messages.
#[derive(Clone, PartialEq, Debug)]
pub struct StoredMessage {
    pub id: String,
    pub user_id: String,
    pub title: Option<String>,
    pub content: String,
    pub message_type: MessageType,
    pub created_at: DateTime<Utc>,
}

/// Messages for a single channel.
#[derive(Store, Default, Clone, PartialEq)]
pub struct ChannelMessages {
    /// All messages in this channel, sorted by created_at ascending.
    pub messages: Vec<StoredMessage>,
    /// Whether the channel history has been fetched from the REST API.
    pub is_loaded: bool,
}

/// Global message store keyed by channel_id.
///
/// Usage:
/// ```rust
/// // Get messages for a channel
/// if let Some(channel) = MESSAGES.resolve().get(&channel_id) {
///     let msgs = channel.messages().read();
///     // render messages...
/// }
///
/// // Add a new message
/// MESSAGES.resolve().write().entry(channel_id)
///     .or_default()
///     .messages
///     .push(new_message);
/// ```
pub static MESSAGES: GlobalStore<HashMap<String, ChannelMessages>> = Global::new(HashMap::new);

impl ChannelMessages {
    /// Add a message to the channel, maintaining sort order by created_at.
    /// Returns false if a message with the same ID already exists (deduplication).
    pub fn add_message(&mut self, msg: StoredMessage) -> bool {
        // Check for duplicate
        if self.messages.iter().any(|m| m.id == msg.id) {
            return false;
        }

        // Find insertion point to maintain sort order
        let pos = self
            .messages
            .binary_search_by(|m| m.created_at.cmp(&msg.created_at))
            .unwrap_or_else(|pos| pos);

        self.messages.insert(pos, msg);
        true
    }

    /// Set the full message history (from REST API fetch).
    /// Marks the channel as loaded.
    pub fn set_history(&mut self, mut messages: Vec<StoredMessage>) {
        // Sort by created_at ascending
        messages.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        self.messages = messages;
        self.is_loaded = true;
    }
}
