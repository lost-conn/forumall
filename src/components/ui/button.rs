use dioxus::prelude::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ButtonVariant {
    Primary,
    Secondary,
    Ghost,
}

impl Default for ButtonVariant {
    fn default() -> Self {
        Self::Primary
    }
}

#[derive(Props, Clone, PartialEq)]
pub struct ButtonProps {
    #[props(optional)]
    pub class: Option<String>,
    #[props(optional)]
    pub variant: Option<ButtonVariant>,
    #[props(optional)]
    pub r#type: Option<String>,
    #[props(optional)]
    pub disabled: Option<bool>,
    #[props(optional)]
    pub onclick: Option<EventHandler<MouseEvent>>,
    pub children: Element,
}

#[component]
pub fn Button(props: ButtonProps) -> Element {
    let variant = props.variant.unwrap_or_default();
    let disabled = props.disabled.unwrap_or(false);

    let base = "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[#1e1f22] disabled:opacity-50 disabled:pointer-events-none";

    let variant_class = match variant {
        ButtonVariant::Primary => "bg-gradient-to-r from-indigo-500 to-purple-600 text-white hover:from-indigo-400 hover:to-purple-500 hover:shadow-lg hover:shadow-indigo-500/25 focus:ring-indigo-500",
        ButtonVariant::Secondary => "bg-[#4e5058] text-white hover:bg-[#6d6f78] focus:ring-gray-500",
        ButtonVariant::Ghost => "bg-transparent text-gray-300 hover:bg-[#3f4147] hover:text-white focus:ring-gray-500",
    };

    let class = match props.class {
        Some(extra) if !extra.is_empty() => format!("{} {} {}", base, variant_class, extra),
        _ => format!("{} {}", base, variant_class),
    };

    rsx! {
        button {
            class,
            r#type: props.r#type.unwrap_or_else(|| "button".to_string()),
            disabled,
            onclick: move |evt| {
                if disabled {
                    return;
                }
                if let Some(handler) = &props.onclick {
                    handler.call(evt);
                }
            },
            {props.children}
        }
    }
}
