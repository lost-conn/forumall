//! Presence selector component - dropdown for availability + status input.

use dioxus::prelude::*;
use forumall_shared::Availability;

#[derive(Props, Clone, PartialEq)]
pub struct PresenceSelectorProps {
    pub availability: Availability,
    pub status: Option<String>,
    pub on_change: EventHandler<(Availability, Option<String>)>,
}

#[component]
pub fn PresenceSelector(props: PresenceSelectorProps) -> Element {
    let mut status_input = use_signal(|| props.status.clone().unwrap_or_default());

    let availability_options = [
        (Availability::Online, "Online", "bg-green-500"),
        (Availability::Away, "Away", "bg-yellow-500"),
        (Availability::Dnd, "Do Not Disturb", "bg-red-500"),
        (Availability::Offline, "Invisible", "bg-gray-500"),
    ];

    rsx! {
        div { class: "space-y-3",
            // Availability dropdown
            div { class: "space-y-1",
                label { class: "text-sm text-gray-400", "Status" }
                div { class: "flex gap-2",
                    for (avail, label, color) in availability_options.iter() {
                        button {
                            class: {
                                let selected = *avail == props.availability;
                                format!(
                                    "flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all {}",
                                    if selected { "bg-[#4e5058] text-white" } else { "bg-[#2b2d31] text-gray-400 hover:bg-[#3f4147]" }
                                )
                            },
                            onclick: {
                                let avail = avail.clone();
                                let on_change = props.on_change.clone();
                                let status = status_input.read().clone();
                                move |_| {
                                    let status = if status.is_empty() { None } else { Some(status.clone()) };
                                    on_change.call((avail.clone(), status));
                                }
                            },
                            span { class: "w-2 h-2 rounded-full {color}" }
                            "{label}"
                        }
                    }
                }
            }

            // Status message input
            div { class: "space-y-1",
                label { class: "text-sm text-gray-400", "Status Message" }
                input {
                    class: "w-full rounded-lg bg-[#1e1f22] text-gray-100 px-4 py-2 text-sm border border-[#3f4147] placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500",
                    r#type: "text",
                    placeholder: "What are you up to?",
                    value: "{status_input}",
                    oninput: move |e| {
                        status_input.set(e.value().clone());
                    },
                    onblur: {
                        let on_change = props.on_change.clone();
                        let availability = props.availability.clone();
                        move |_| {
                            let status = status_input.read().clone();
                            let status = if status.is_empty() { None } else { Some(status) };
                            on_change.call((availability.clone(), status));
                        }
                    },
                }
            }
        }
    }
}
