//! Global stores for application state.

pub mod messages;
pub mod presence;
pub mod profile;

pub use messages::{ChannelMessages, StoredMessage, MESSAGES};
pub use presence::{
    clear_current_presence, get_availability, get_cached_presence, set_current_presence,
    update_user_presence, CURRENT_PRESENCE, USER_PRESENCE,
};
pub use profile::{
    cache_profile, clear_current_profile, get_cached_profile, set_current_profile,
    CURRENT_PROFILE, USER_PROFILES,
};
