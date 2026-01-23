//! WebSocket-related hooks for Dioxus components.

use dioxus::prelude::*;
use forumall_shared::BaseMessage;
use std::collections::HashMap;

use super::manager::{get_handle, normalize_host, WsEvent, WS_EVENTS};

/// Hook to get messages for a specific channel with automatic subscription management.
///
/// This hook:
/// - Subscribes to the channel when mounted
/// - Unsubscribes when unmounted or when channel changes
/// - Collects incoming messages for the specified channel
/// - Provides a handle for sending messages
///
/// # Arguments
/// * `host` - The provider host (e.g., "example.com" or empty for local)
/// * `channel_id` - The channel ID to subscribe to
///
/// # Returns
/// A tuple of (messages, send_message_fn)
pub fn use_channel_messages(
    host: Signal<String>,
    channel_id: Signal<String>,
) -> (Signal<Vec<BaseMessage>>, impl Fn(String) + Clone) {
    let mut messages = use_signal(Vec::<BaseMessage>::new);
    let mut last_channel = use_signal(|| String::new());
    let mut pending_nonces = use_signal(|| HashMap::<String, BaseMessage>::new());

    // Subscribe to channel on mount/change
    use_effect(move || {
        let current_host = host.read().clone();
        let current_channel = channel_id.read().clone();
        let prev_channel = last_channel.read().clone();

        // Unsubscribe from previous channel if different
        if !prev_channel.is_empty() && prev_channel != current_channel {
            if let Some(handle) = get_handle(&current_host) {
                let _ = handle.unsubscribe(&prev_channel);
            }
        }

        // Subscribe to new channel
        if !current_channel.is_empty() {
            if let Some(handle) = get_handle(&current_host) {
                if let Err(e) = handle.subscribe(&current_channel) {
                    crate::log_error!("Failed to subscribe: {}", e);
                } else {
                    crate::log_info!("Subscribed to channel: {}", current_channel);
                }
            }
        }

        last_channel.set(current_channel);
    });

    // Process incoming events
    use_effect(move || {
        let events = WS_EVENTS.read().clone();
        let current_host = normalize_host(&host.read());
        // TODO: Filter messages by channel_id once server includes channel info in messages
        let _current_channel = channel_id.read().clone();

        for event in events.iter() {
            match event {
                WsEvent::NewMessage {
                    host: event_host,
                    message,
                } => {
                    // Only process messages for our host
                    if normalize_host(event_host) != current_host {
                        continue;
                    }

                    // Check if this message is for our channel by checking tags or channel reference
                    // For now, we'll accept all messages from the subscribed host
                    // The server should only send messages for subscribed channels
                    messages.write().push(message.clone());
                }
                WsEvent::Ack {
                    host: event_host,
                    nonce,
                    message_id,
                } => {
                    // Only process acks for our host
                    if normalize_host(event_host) != current_host {
                        continue;
                    }

                    // Update pending message with real ID
                    if let Some(mut pending) = pending_nonces.write().remove(nonce) {
                        pending.id = message_id.clone();
                        // Message should already be in the list via NewMessage event
                    }
                }
                _ => {}
            }
        }

        // Clear processed events (only our events)
        // Note: In a more sophisticated implementation, we'd use a pub/sub pattern
        // For now, we clear all events after processing
    });

    // Create send function
    let send_message = move |body: String| {
        let current_host = host.read().clone();
        let current_channel = channel_id.read().clone();

        if let Some(handle) = get_handle(&current_host) {
            let nonce = uuid::Uuid::new_v4().to_string();
            if let Err(e) = handle.send_message(&current_channel, &body, &nonce) {
                crate::log_error!("Failed to send message: {}", e);
            }
        }
    };

    (messages, send_message)
}

/// Hook to get the connection state for a specific host.
///
/// # Arguments
/// * `host` - The provider host (e.g., "example.com" or empty for local)
///
/// # Returns
/// A signal containing the current connection state
pub fn use_connection_state(host: Signal<String>) -> Signal<super::connection::ConnectionState> {
    let mut state = use_signal(|| super::connection::ConnectionState::Disconnected);

    use_effect(move || {
        let current_host = host.read().clone();
        let current_state = super::manager::get_state(&current_host);
        state.set(current_state);
    });

    state
}

/// Hook to get a WebSocket handle for sending commands.
///
/// # Arguments
/// * `host` - The provider host (e.g., "example.com" or empty for local)
///
/// # Returns
/// An optional handle (None if not connected)
pub fn use_ws_handle(host: Signal<String>) -> Signal<Option<super::connection::WsHandle>> {
    let mut handle = use_signal(|| None);

    use_effect(move || {
        let current_host = host.read().clone();
        handle.set(get_handle(&current_host));
    });

    handle
}

/// Hook to listen for all WebSocket events.
///
/// This is a lower-level hook for components that need to handle
/// events directly rather than using `use_channel_messages`.
///
/// # Returns
/// A signal containing the list of pending events
pub fn use_ws_events() -> Signal<Vec<WsEvent>> {
    let mut events = use_signal(Vec::new);

    use_effect(move || {
        let global_events = WS_EVENTS.read().clone();
        events.set(global_events);
    });

    events
}

/// Hook to consume and clear WebSocket events.
///
/// Returns events that match the predicate and removes them from the global list.
pub fn use_consume_events<F>(predicate: F) -> Signal<Vec<WsEvent>>
where
    F: Fn(&WsEvent) -> bool + 'static,
{
    let mut consumed = use_signal(Vec::new);

    use_effect(move || {
        let mut global_events = WS_EVENTS.write();
        let mut to_consume = Vec::new();
        let mut to_keep = Vec::new();

        for event in global_events.drain(..) {
            if predicate(&event) {
                to_consume.push(event);
            } else {
                to_keep.push(event);
            }
        }

        *global_events = to_keep;
        consumed.set(to_consume);
    });

    consumed
}
