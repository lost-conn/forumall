use dioxus::prelude::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum InputType {
    Text,
    Password,
}

impl InputType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Password => "password",
        }
    }
}

#[derive(Props, Clone, PartialEq)]
pub struct TextInputProps {
    #[props(optional)]
    pub class: Option<String>,
    pub value: String,
    pub oninput: EventHandler<FormEvent>,
    #[props(optional)]
    pub placeholder: Option<String>,
    #[props(optional)]
    pub input_type: Option<InputType>,
}

#[component]
pub fn TextInput(props: TextInputProps) -> Element {
    let base = "w-full rounded-lg bg-[#1e1f22] text-gray-100 px-4 py-3 text-sm border border-[#3f4147] placeholder-gray-500 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500";
    let class = match props.class {
        Some(extra) if !extra.is_empty() => format!("{} {}", base, extra),
        _ => base.to_string(),
    };

    rsx! {
        input {
            class,
            r#type: props.input_type.unwrap_or(InputType::Text).as_str(),
            value: "{props.value}",
            placeholder: props.placeholder.unwrap_or_default(),
            oninput: move |e| props.oninput.call(e),
        }
    }
}
