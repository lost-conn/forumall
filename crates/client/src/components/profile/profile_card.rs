//! Profile card component - displays a user's profile summary.

use dioxus::prelude::*;
use forumall_shared::{Availability, UserProfile};

use super::PresenceIndicator;

#[derive(Props, Clone, PartialEq)]
pub struct ProfileCardProps {
    pub profile: UserProfile,
    #[props(optional)]
    pub availability: Option<Availability>,
    #[props(optional)]
    pub status: Option<String>,
}

#[component]
pub fn ProfileCard(props: ProfileCardProps) -> Element {
    let display_name = props
        .profile
        .display_name
        .as_ref()
        .unwrap_or(&props.profile.handle);
    let avatar_url = props.profile.avatar.as_deref();
    let bio = props.profile.bio.as_deref();
    let availability = props.availability.clone().unwrap_or(Availability::Offline);

    rsx! {
        div { class: "bg-[#2b2d31] rounded-xl p-6 space-y-4",
            // Avatar and name section
            div { class: "flex items-center gap-4",
                // Avatar
                div { class: "relative",
                    if let Some(url) = avatar_url {
                        img {
                            class: "w-20 h-20 rounded-full object-cover",
                            src: "{url}",
                            alt: "{display_name}",
                        }
                    } else {
                        div { class: "w-20 h-20 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-2xl font-bold",
                            {display_name.chars().next().unwrap_or('?').to_uppercase().to_string()}
                        }
                    }

                    // Presence indicator
                    div { class: "absolute bottom-0 right-0 p-0.5 bg-[#2b2d31] rounded-full",
                        PresenceIndicator {
                            availability: availability.clone(),
                            size: "w-4 h-4",
                        }
                    }
                }

                // Name and handle
                div { class: "flex-1",
                    h2 { class: "text-xl font-bold text-white", "{display_name}" }
                    p { class: "text-gray-400 text-sm", "@{props.profile.handle}@{props.profile.domain}" }
                    if let Some(status) = &props.status {
                        p { class: "text-gray-300 text-sm mt-1", "{status}" }
                    }
                }
            }

            // Bio
            if let Some(bio) = bio {
                div { class: "border-t border-[#3f4147] pt-4",
                    p { class: "text-gray-300 text-sm", "{bio}" }
                }
            }
        }
    }
}
