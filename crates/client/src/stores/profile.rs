//! Profile store for user profile data.

use std::collections::HashMap;

use dioxus::prelude::*;
use forumall_shared::UserProfile;

/// Current user's profile
pub static CURRENT_PROFILE: GlobalSignal<Option<UserProfile>> = Signal::global(|| None);

/// Cache of other users' profiles, keyed by "handle@domain"
pub static USER_PROFILES: GlobalSignal<HashMap<String, UserProfile>> = Signal::global(HashMap::new);

/// Set the current user's profile
pub fn set_current_profile(profile: UserProfile) {
    *CURRENT_PROFILE.write() = Some(profile);
}

/// Clear the current user's profile (on logout)
pub fn clear_current_profile() {
    *CURRENT_PROFILE.write() = None;
}

/// Cache a user's profile
pub fn cache_profile(profile: UserProfile) {
    let key = format!("{}@{}", profile.handle, profile.domain);
    USER_PROFILES.write().insert(key, profile);
}

/// Get a cached user profile
pub fn get_cached_profile(handle: &str, domain: &str) -> Option<UserProfile> {
    let key = format!("{}@{}", handle, domain);
    USER_PROFILES.read().get(&key).cloned()
}
