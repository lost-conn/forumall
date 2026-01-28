//! Profile edit form component.

use dioxus::prelude::*;
use forumall_shared::{UpdateProfileRequest, UserProfile};

use crate::components::ui::{Button, ButtonVariant, TextInput};

#[derive(Props, Clone, PartialEq)]
pub struct ProfileEditFormProps {
    pub profile: UserProfile,
    pub on_save: EventHandler<UpdateProfileRequest>,
    #[props(optional)]
    pub saving: Option<bool>,
}

#[component]
pub fn ProfileEditForm(props: ProfileEditFormProps) -> Element {
    let mut display_name = use_signal(|| {
        props
            .profile
            .display_name
            .clone()
            .unwrap_or_default()
    });
    let mut avatar_url = use_signal(|| props.profile.avatar.clone().unwrap_or_default());
    let mut bio = use_signal(|| props.profile.bio.clone().unwrap_or_default());

    let saving = props.saving.unwrap_or(false);

    rsx! {
        div { class: "space-y-6",
            // Display Name
            div { class: "space-y-2",
                label { class: "text-sm font-medium text-gray-300", "Display Name" }
                TextInput {
                    value: display_name.read().clone(),
                    placeholder: "How you want to be known",
                    oninput: move |e: FormEvent| display_name.set(e.value().clone()),
                }
            }

            // Avatar URL
            div { class: "space-y-2",
                label { class: "text-sm font-medium text-gray-300", "Avatar URL" }
                div { class: "flex gap-3 items-center",
                    // Preview
                    if avatar_url.read().is_empty() {
                        div { class: "w-16 h-16 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-xl font-bold flex-shrink-0",
                            {props.profile.handle.chars().next().unwrap_or('?').to_uppercase().to_string()}
                        }
                    } else {
                        img {
                            class: "w-16 h-16 rounded-full object-cover flex-shrink-0",
                            src: "{avatar_url}",
                            alt: "Avatar preview",
                        }
                    }
                    div { class: "flex-1",
                        TextInput {
                            value: avatar_url.read().clone(),
                            placeholder: "https://example.com/avatar.png",
                            oninput: move |e: FormEvent| avatar_url.set(e.value().clone()),
                        }
                    }
                }
            }

            // Bio
            div { class: "space-y-2",
                label { class: "text-sm font-medium text-gray-300", "Bio" }
                textarea {
                    class: "w-full rounded-lg bg-[#1e1f22] text-gray-100 px-4 py-3 text-sm border border-[#3f4147] placeholder-gray-500 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 min-h-[100px] resize-y",
                    placeholder: "Tell us about yourself...",
                    value: "{bio}",
                    oninput: move |e: FormEvent| bio.set(e.value().clone()),
                }
            }

            // Save button
            Button {
                variant: ButtonVariant::Primary,
                disabled: saving,
                onclick: {
                    let on_save = props.on_save.clone();
                    move |_| {
                        let update = UpdateProfileRequest {
                            display_name: if display_name.read().is_empty() {
                                None
                            } else {
                                Some(display_name.read().clone())
                            },
                            avatar: if avatar_url.read().is_empty() {
                                None
                            } else {
                                Some(avatar_url.read().clone())
                            },
                            bio: if bio.read().is_empty() {
                                None
                            } else {
                                Some(bio.read().clone())
                            },
                            metadata: None,
                        };
                        on_save.call(update);
                    }
                },
                if saving { "Saving..." } else { "Save Profile" }
            }
        }
    }
}
