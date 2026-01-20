use dioxus::prelude::*;

#[derive(Props, Clone, PartialEq)]
pub struct CardProps {
    #[props(optional)]
    pub class: Option<String>,
    pub children: Element,
}

#[component]
pub fn Card(props: CardProps) -> Element {
    let base = "rounded-xl border border-[#2d2f34] bg-[#1e1f22]/90 backdrop-blur-md shadow-xl";
    let class = match props.class {
        Some(extra) if !extra.is_empty() => format!("{} {}", base, extra),
        _ => base.to_string(),
    };

    rsx! {
        div { class, {props.children} }
    }
}

#[derive(Props, Clone, PartialEq)]
pub struct CardHeaderProps {
    pub title: String,
    #[props(optional)]
    pub subtitle: Option<String>,
}

#[component]
pub fn CardHeader(props: CardHeaderProps) -> Element {
    rsx! {
        div { class: "px-6 pt-6 pb-2",
            h2 { class: "text-2xl font-bold text-white", "{props.title}" }
            if let Some(sub) = &props.subtitle {
                p { class: "mt-1 text-sm text-gray-400", "{sub}" }
            }
        }
    }
}

#[derive(Props, Clone, PartialEq)]
pub struct CardBodyProps {
    pub children: Element,
}

#[component]
pub fn CardBody(props: CardBodyProps) -> Element {
    rsx! {
        div { class: "px-6 pb-6 pt-4", {props.children} }
    }
}
