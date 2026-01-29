//! Profile popup component - displays a user's profile in a modal overlay.

use crate::auth_session::AuthContext;
use dioxus::prelude::*;
use forumall_shared::{Presence, UserProfile};

use super::PresenceIndicator;

/// ProfilePopup - Modal overlay for viewing a user's profile.
#[component]
pub fn ProfilePopup(user_id: String, on_close: EventHandler<()>) -> Element {
    let auth = use_context::<AuthContext>();
    let user_id_sig = use_signal(|| user_id.clone());

    // Fetch profile (supports federated users via domain extraction)
    let profile = use_resource(move || {
        let uid = user_id_sig();
        let auth = auth;
        async move {
            // Extract handle and domain from user_id (format: "handle" or "handle@domain")
            let parts: Vec<&str> = uid.split('@').collect();
            let handle = parts.first().copied().unwrap_or(&uid);
            let domain = parts.get(1).copied();

            let client = auth.client();
            let url = auth.api_url_for_host(domain, &format!("/api/users/{handle}/profile"));
            client
                .get_json::<UserProfile>(&url)
                .await
                .map_err(|e| e.to_string())
        }
    });

    // Fetch presence (supports federated users via domain extraction)
    let presence = use_resource(move || {
        let uid = user_id_sig();
        let auth = auth;
        async move {
            // Extract handle and domain from user_id
            let parts: Vec<&str> = uid.split('@').collect();
            let handle = parts.first().copied().unwrap_or(&uid);
            let domain = parts.get(1).copied();

            let client = auth.client();
            let url = auth.api_url_for_host(domain, &format!("/api/users/{handle}/presence"));
            client
                .get_json::<Presence>(&url)
                .await
                .ok() // Return None on error instead of failing
        }
    });

    rsx! {
        // Backdrop
        div {
            class: "fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm",
            onclick: move |_| on_close.call(()),
            // Modal container
            div {
                class: "relative w-full max-w-sm mx-4 bg-[#2b2d31] rounded-xl shadow-2xl overflow-hidden",
                onclick: move |e| e.stop_propagation(),
                // Close button
                button {
                    class: "absolute top-3 right-3 text-[#b5bac1] hover:text-white transition-colors z-10",
                    onclick: move |_| on_close.call(()),
                    svg {
                        class: "w-5 h-5",
                        fill: "none",
                        stroke: "currentColor",
                        view_box: "0 0 24 24",
                        path {
                            stroke_linecap: "round",
                            stroke_linejoin: "round",
                            stroke_width: "2",
                            d: "M6 18L18 6M6 6l12 12",
                        }
                    }
                }
                // Content
                match profile.read().as_ref() {
                    Some(Ok(p)) => {
                        let display_name = p.display_name.as_ref().unwrap_or(&p.handle);
                        let initial = display_name.chars().next().unwrap_or('?').to_uppercase().to_string();
                        let presence_data = presence.read();
                        let availability = presence_data.as_ref().and_then(|opt| opt.as_ref()).map(|pr| pr.availability.clone());
                        let status = presence_data.as_ref().and_then(|opt| opt.as_ref()).and_then(|pr| pr.status.clone());
                        rsx! {
                            // Banner/header area
                            div { class: "h-16 bg-gradient-to-r from-indigo-500 to-purple-600" }
                            // Profile content
                            div { class: "px-4 pb-4 -mt-8",
                                // Avatar
                                div { class: "relative inline-block",
                                    if let Some(ref url) = p.avatar {
                                        img {
                                            class: "w-20 h-20 rounded-full object-cover border-4 border-[#2b2d31]",
                                            src: "{url}",
                                            alt: "{display_name}",
                                        }
                                    } else {
                                        div { class: "w-20 h-20 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-2xl font-bold border-4 border-[#2b2d31]",
                                            "{initial}"
                                        }
                                    }
                                    // Presence indicator
                                    if let Some(ref avail) = availability {
                                        div { class: "absolute bottom-0 right-0 p-0.5 bg-[#2b2d31] rounded-full",
                                            PresenceIndicator {
                                                availability: avail.clone(),
                                                size: "w-5 h-5",
                                            }
                                        }
                                    }
                                }
                                // Name and handle
                                div { class: "mt-3",
                                    h2 { class: "text-xl font-bold text-white", "{display_name}" }
                                    p { class: "text-[#b5bac1] text-sm", "@{p.handle}@{p.domain}" }
                                    if let Some(ref status_text) = status {
                                        p { class: "text-gray-300 text-sm mt-1 italic", "{status_text}" }
                                    }
                                }
                                // Bio
                                if let Some(ref bio) = p.bio {
                                    div { class: "mt-4 pt-4 border-t border-[#3f4147]",
                                        p { class: "text-[#dbdee1] text-sm leading-relaxed", "{bio}" }
                                    }
                                }
                            }
                        }
                    }
                    Some(Err(e)) => rsx! {
                        div { class: "p-6 text-center",
                            p { class: "text-red-400", "Failed to load profile" }
                            p { class: "text-gray-500 text-sm mt-1", "{e}" }
                        }
                    },
                    None => rsx! {
                        div { class: "p-6 flex justify-center",
                            div { class: "w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" }
                        }
                    },
                }
            }
        }
    }
}
