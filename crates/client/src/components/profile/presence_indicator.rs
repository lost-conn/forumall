//! Presence indicator component - shows a colored dot for availability status.

use dioxus::prelude::*;
use forumall_shared::Availability;

#[derive(Props, Clone, PartialEq)]
pub struct PresenceIndicatorProps {
    pub availability: Availability,
    #[props(optional)]
    pub size: Option<&'static str>,
}

#[component]
pub fn PresenceIndicator(props: PresenceIndicatorProps) -> Element {
    let size = props.size.unwrap_or("w-3 h-3");

    let color_class = match props.availability {
        Availability::Online => "bg-green-500",
        Availability::Away => "bg-yellow-500",
        Availability::Dnd => "bg-red-500",
        Availability::Offline => "bg-gray-500",
    };

    let title = match props.availability {
        Availability::Online => "Online",
        Availability::Away => "Away",
        Availability::Dnd => "Do Not Disturb",
        Availability::Offline => "Offline",
    };

    rsx! {
        span {
            class: "{size} {color_class} rounded-full inline-block",
            title: "{title}",
        }
    }
}
