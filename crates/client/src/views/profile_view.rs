//! Profile view - shows and allows editing of user profile, presence, and privacy settings.

use dioxus::prelude::*;
use forumall_shared::{
    Availability, Presence, PrivacySettings, UpdatePresenceRequest, UpdateProfileRequest,
    UserProfile,
};

use crate::api_client::ApiClient;
use crate::auth_session::AuthContext;
use crate::components::profile::{
    PresenceSelector, PrivacySettingsPanel, ProfileCard, ProfileEditForm,
};
use crate::stores::{set_current_presence, set_current_profile};

#[component]
pub fn ProfileView() -> Element {
    let auth = use_context::<AuthContext>();

    // State for profile data
    let mut profile = use_signal(|| None::<UserProfile>);
    let mut presence = use_signal(|| None::<Presence>);
    let mut privacy = use_signal(|| None::<PrivacySettings>);

    // Loading and saving states
    let mut loading = use_signal(|| true);
    let mut saving_profile = use_signal(|| false);
    let mut saving_presence = use_signal(|| false);
    let mut saving_privacy = use_signal(|| false);
    let mut error = use_signal(|| None::<String>);

    // Fetch profile data on mount
    use_effect(move || {
        let session = auth.session.read().clone();
        if session.is_none() {
            loading.set(false);
            return;
        }

        spawn(async move {
            let session = auth.session.read().clone();
            let Some(sess) = session else {
                loading.set(false);
                return;
            };

            let client = ApiClient::new()
                .with_base_url(auth.api_url(""))
                .with_signing(sess.keys.clone(), Some(sess.user_id.clone()), Some(auth.provider_domain.read().clone()));

            // Fetch profile
            let handle = sess.user_id.split('@').next().unwrap_or(&sess.user_id);
            match client.get_user_profile(handle).await {
                Ok(p) => {
                    profile.set(Some(p.clone()));
                    set_current_profile(p);
                }
                Err(e) => {
                    error.set(Some(format!("Failed to load profile: {}", e)));
                }
            }

            // Fetch presence
            match client.get_own_presence().await {
                Ok(p) => {
                    presence.set(Some(p.clone()));
                    set_current_presence(p);
                }
                Err(e) => {
                    crate::log_warn!("Failed to load presence: {}", e);
                }
            }

            // Fetch privacy settings
            match client.get_privacy_settings().await {
                Ok(p) => privacy.set(Some(p)),
                Err(e) => {
                    crate::log_warn!("Failed to load privacy settings: {}", e);
                }
            }

            loading.set(false);
        });
    });

    // Handle profile update
    let on_save_profile = move |update: UpdateProfileRequest| {
        saving_profile.set(true);

        spawn(async move {
            let session = auth.session.read().clone();
            let Some(sess) = session else {
                saving_profile.set(false);
                return;
            };

            let client = ApiClient::new()
                .with_base_url(auth.api_url(""))
                .with_signing(sess.keys.clone(), Some(sess.user_id.clone()), Some(auth.provider_domain.read().clone()));

            match client.update_profile(&update).await {
                Ok(p) => {
                    profile.set(Some(p.clone()));
                    set_current_profile(p);
                }
                Err(e) => {
                    error.set(Some(format!("Failed to save profile: {}", e)));
                }
            }

            saving_profile.set(false);
        });
    };

    // Handle presence update
    let on_presence_change = move |(availability, status): (Availability, Option<String>)| {
        saving_presence.set(true);

        spawn(async move {
            let session = auth.session.read().clone();
            let Some(sess) = session else {
                saving_presence.set(false);
                return;
            };

            let client = ApiClient::new()
                .with_base_url(auth.api_url(""))
                .with_signing(sess.keys.clone(), Some(sess.user_id.clone()), Some(auth.provider_domain.read().clone()));

            let update = UpdatePresenceRequest { availability, status };

            match client.update_presence(&update).await {
                Ok(p) => {
                    presence.set(Some(p.clone()));
                    set_current_presence(p);
                }
                Err(e) => {
                    crate::log_warn!("Failed to update presence: {}", e);
                }
            }

            saving_presence.set(false);
        });
    };

    // Handle privacy update
    let on_save_privacy = move |settings: PrivacySettings| {
        saving_privacy.set(true);

        spawn(async move {
            let session = auth.session.read().clone();
            let Some(sess) = session else {
                saving_privacy.set(false);
                return;
            };

            let client = ApiClient::new()
                .with_base_url(auth.api_url(""))
                .with_signing(sess.keys.clone(), Some(sess.user_id.clone()), Some(auth.provider_domain.read().clone()));

            match client.update_privacy_settings(&settings).await {
                Ok(p) => privacy.set(Some(p)),
                Err(e) => {
                    error.set(Some(format!("Failed to save privacy settings: {}", e)));
                }
            }

            saving_privacy.set(false);
        });
    };

    // Check if logged in
    let session = auth.session.read();
    if session.is_none() {
        return rsx! {
            div { class: "flex items-center justify-center h-full",
                p { class: "text-gray-400", "Please log in to view your profile" }
            }
        };
    }

    // Loading state
    if *loading.read() {
        return rsx! {
            div { class: "flex items-center justify-center h-full",
                div { class: "animate-spin rounded-full h-8 w-8 border-2 border-indigo-500 border-t-transparent" }
            }
        };
    }

    // Error state
    if let Some(err) = error.read().as_ref() {
        return rsx! {
            div { class: "flex items-center justify-center h-full",
                p { class: "text-red-400", "{err}" }
            }
        };
    }

    let Some(profile_data) = profile.read().clone() else {
        return rsx! {
            div { class: "flex items-center justify-center h-full",
                p { class: "text-gray-400", "Failed to load profile" }
            }
        };
    };

    let presence_data = presence.read().clone().unwrap_or_default();
    let privacy_data = privacy.read().clone().unwrap_or_default();

    rsx! {
        div { class: "h-full overflow-y-auto bg-[#313338]",
            div { class: "max-w-2xl mx-auto py-8 px-4 space-y-8",
                // Header
                h1 { class: "text-2xl font-bold text-white", "Your Profile" }

                // Profile card preview
                ProfileCard {
                    profile: profile_data.clone(),
                    availability: Some(presence_data.availability.clone()),
                    status: presence_data.status.clone(),
                }

                // Edit sections in tabs/accordion
                div { class: "space-y-6",
                    // Profile edit section
                    div { class: "bg-[#2b2d31] rounded-xl p-6",
                        h3 { class: "text-lg font-semibold text-white mb-4", "Edit Profile" }
                        ProfileEditForm {
                            profile: profile_data,
                            on_save: on_save_profile,
                            saving: *saving_profile.read(),
                        }
                    }

                    // Presence section
                    div { class: "bg-[#2b2d31] rounded-xl p-6",
                        h3 { class: "text-lg font-semibold text-white mb-4", "Presence" }
                        PresenceSelector {
                            availability: presence_data.availability,
                            status: presence_data.status,
                            on_change: on_presence_change,
                        }
                    }

                    // Privacy section
                    div { class: "bg-[#2b2d31] rounded-xl p-6",
                        PrivacySettingsPanel {
                            settings: privacy_data,
                            on_save: on_save_privacy,
                            saving: *saving_privacy.read(),
                        }
                    }
                }
            }
        }
    }
}
