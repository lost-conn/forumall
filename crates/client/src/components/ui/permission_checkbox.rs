//! Permission checkbox component for channel settings.

use dioxus::prelude::*;

/// A checkbox component for permission settings with Discord-like styling.
#[component]
pub fn PermissionCheckbox(
    label: String,
    description: Option<String>,
    checked: bool,
    onchange: EventHandler<bool>,
) -> Element {
    rsx! {
        label { class: "flex items-center gap-3 p-3 rounded bg-[#2b2d31] cursor-pointer hover:bg-[#404249] transition-colors",
            input {
                r#type: "checkbox",
                checked: checked,
                onchange: move |e: Event<FormData>| {
                    onchange.call(e.checked());
                },
                class: "w-5 h-5 rounded border-none bg-[#1e1f22] text-indigo-500 focus:ring-0 focus:ring-offset-0 cursor-pointer",
            }
            div { class: "flex-1",
                div { class: "text-white font-medium text-sm", "{label}" }
                if let Some(desc) = description {
                    div { class: "text-xs text-[#b5bac1] mt-0.5", "{desc}" }
                }
            }
        }
    }
}
