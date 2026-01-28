//! Presence store for user presence data.

use std::collections::HashMap;

use dioxus::prelude::*;
use forumall_shared::{Availability, Presence};

/// Current user's presence
pub static CURRENT_PRESENCE: GlobalSignal<Option<Presence>> = Signal::global(|| None);

/// Cache of other users' presence, keyed by "handle@domain"
pub static USER_PRESENCE: GlobalSignal<HashMap<String, Presence>> = Signal::global(HashMap::new);

/// Set the current user's presence
pub fn set_current_presence(presence: Presence) {
    *CURRENT_PRESENCE.write() = Some(presence);
}

/// Clear the current user's presence (on logout)
pub fn clear_current_presence() {
    *CURRENT_PRESENCE.write() = None;
}

/// Update presence for a user (from WebSocket events)
pub fn update_user_presence(handle: &str, domain: &str, presence: Presence) {
    let key = format!("{}@{}", handle, domain);
    USER_PRESENCE.write().insert(key, presence);
}

/// Get a cached user presence
pub fn get_cached_presence(handle: &str, domain: &str) -> Option<Presence> {
    let key = format!("{}@{}", handle, domain);
    USER_PRESENCE.read().get(&key).cloned()
}

/// Get availability for a user, defaulting to Offline if not found
pub fn get_availability(handle: &str, domain: &str) -> Availability {
    get_cached_presence(handle, domain)
        .map(|p| p.availability)
        .unwrap_or(Availability::Offline)
}
