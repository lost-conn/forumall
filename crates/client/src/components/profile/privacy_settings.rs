//! Privacy settings panel component.

use dioxus::prelude::*;
use forumall_shared::{PrivacySettings, VisibilityPolicy};

use crate::components::ui::{Button, ButtonVariant};

#[derive(Props, Clone, PartialEq)]
pub struct PrivacySettingsPanelProps {
    pub settings: PrivacySettings,
    pub on_save: EventHandler<PrivacySettings>,
    #[props(optional)]
    pub saving: Option<bool>,
}

#[component]
pub fn PrivacySettingsPanel(props: PrivacySettingsPanelProps) -> Element {
    let mut presence_vis = use_signal(|| props.settings.presence_visibility.clone());
    let mut profile_vis = use_signal(|| props.settings.profile_visibility.clone());
    let mut membership_vis = use_signal(|| props.settings.membership_visibility.clone());

    let saving = props.saving.unwrap_or(false);

    rsx! {
        div { class: "space-y-6",
            h3 { class: "text-lg font-semibold text-white", "Privacy Settings" }
            p { class: "text-sm text-gray-400", "Control who can see your information" }

            // Presence visibility
            VisibilitySelect {
                label: "Who can see your presence",
                description: "Controls who can see if you're online",
                value: presence_vis.read().clone(),
                on_change: move |v| presence_vis.set(v),
            }

            // Profile visibility
            VisibilitySelect {
                label: "Who can see your profile",
                description: "Controls who can view your profile details",
                value: profile_vis.read().clone(),
                on_change: move |v| profile_vis.set(v),
            }

            // Membership visibility
            VisibilitySelect {
                label: "Who can see your group memberships",
                description: "Controls who can see which groups you're in",
                value: membership_vis.read().clone(),
                on_change: move |v| membership_vis.set(v),
            }

            // Save button
            Button {
                variant: ButtonVariant::Primary,
                disabled: saving,
                onclick: {
                    let on_save = props.on_save.clone();
                    move |_| {
                        on_save.call(PrivacySettings {
                            presence_visibility: presence_vis.read().clone(),
                            profile_visibility: profile_vis.read().clone(),
                            membership_visibility: membership_vis.read().clone(),
                        });
                    }
                },
                if saving { "Saving..." } else { "Save Privacy Settings" }
            }
        }
    }
}

#[derive(Props, Clone, PartialEq)]
struct VisibilitySelectProps {
    label: &'static str,
    description: &'static str,
    value: VisibilityPolicy,
    on_change: EventHandler<VisibilityPolicy>,
}

#[component]
fn VisibilitySelect(props: VisibilitySelectProps) -> Element {
    let options = [
        (VisibilityPolicy::Public, "Everyone", "Anyone can see"),
        (
            VisibilityPolicy::Authenticated,
            "Logged-in users",
            "Only authenticated users",
        ),
        (
            VisibilityPolicy::SharedGroups,
            "Shared groups",
            "Only people in your groups",
        ),
        (VisibilityPolicy::Nobody, "Nobody", "Hidden from everyone"),
    ];

    rsx! {
        div { class: "bg-[#1e1f22] rounded-lg p-4 space-y-3",
            div {
                label { class: "text-sm font-medium text-white", "{props.label}" }
                p { class: "text-xs text-gray-400", "{props.description}" }
            }

            select {
                class: "w-full rounded-lg bg-[#2b2d31] text-gray-100 px-4 py-2 text-sm border border-[#3f4147] focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500",
                value: visibility_to_value(&props.value),
                onchange: {
                    let on_change = props.on_change.clone();
                    move |e: FormEvent| {
                        let policy = value_to_visibility(&e.value());
                        on_change.call(policy);
                    }
                },
                for (policy, label, _desc) in options.iter() {
                    option {
                        value: visibility_to_value(policy),
                        selected: *policy == props.value,
                        "{label}"
                    }
                }
            }
        }
    }
}

fn visibility_to_value(v: &VisibilityPolicy) -> &'static str {
    match v {
        VisibilityPolicy::Public => "public",
        VisibilityPolicy::Authenticated => "authenticated",
        VisibilityPolicy::SharedGroups => "sharedGroups",
        VisibilityPolicy::Contacts => "contacts",
        VisibilityPolicy::Nobody => "nobody",
    }
}

fn value_to_visibility(s: &str) -> VisibilityPolicy {
    match s {
        "authenticated" => VisibilityPolicy::Authenticated,
        "sharedGroups" => VisibilityPolicy::SharedGroups,
        "contacts" => VisibilityPolicy::Contacts,
        "nobody" => VisibilityPolicy::Nobody,
        _ => VisibilityPolicy::Public,
    }
}
