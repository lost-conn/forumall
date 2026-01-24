//! Message type selector component for channel settings.

use dioxus::prelude::*;
use forumall_shared::MessageType;

/// A horizontal checkbox group for selecting allowed message types.
#[component]
pub fn MessageTypeSelector(
    label: String,
    selected: Vec<MessageType>,
    onchange: EventHandler<Vec<MessageType>>,
) -> Element {
    let all_types = [MessageType::Message, MessageType::Memo, MessageType::Article];

    rsx! {
        div { class: "space-y-2",
            label { class: "block text-xs font-bold text-[#b5bac1] uppercase", "{label}" }
            div { class: "flex flex-wrap gap-2",
                for msg_type in all_types.iter() {
                    {
                        let msg_type_clone = msg_type.clone();
                        let is_checked = selected.contains(msg_type);
                        let type_name = match msg_type {
                            MessageType::Message => "Message",
                            MessageType::Memo => "Memo",
                            MessageType::Article => "Article",
                        };
                        let selected_clone = selected.clone();
                        rsx! {
                            label {
                                key: "{type_name}",
                                class: format!(
                                    "flex items-center gap-2 px-3 py-2 rounded cursor-pointer transition-colors {}",
                                    if is_checked {
                                        "bg-indigo-500/20 border border-indigo-500"
                                    } else {
                                        "bg-[#2b2d31] border border-transparent hover:bg-[#404249]"
                                    }
                                ),
                                input {
                                    r#type: "checkbox",
                                    checked: is_checked,
                                    onchange: {
                                        let msg_type_clone = msg_type_clone.clone();
                                        let selected_clone = selected_clone.clone();
                                        move |_| {
                                            let mut new_selected = selected_clone.clone();
                                            if new_selected.contains(&msg_type_clone) {
                                                new_selected.retain(|t| t != &msg_type_clone);
                                            } else {
                                                new_selected.push(msg_type_clone.clone());
                                            }
                                            onchange.call(new_selected);
                                        }
                                    },
                                    class: "w-4 h-4 rounded border-none bg-[#1e1f22] text-indigo-500 focus:ring-0 focus:ring-offset-0 cursor-pointer",
                                }
                                span { class: "text-sm text-white", "{type_name}" }
                            }
                        }
                    }
                }
            }
        }
    }
}
