//! Article message component - collapsed forum-style with expandable view.

use crate::auth_session::AuthContext;
use chrono::{DateTime, Local, Utc};
use dioxus::prelude::*;
use forumall_shared::UserProfile;

/// Format a DateTime<Utc> into a human-readable format
fn format_timestamp(dt: DateTime<Utc>) -> String {
    let local: DateTime<Local> = dt.with_timezone(&Local);
    let now = Local::now();
    let today = now.date_naive();
    let msg_date = local.date_naive();
    let yesterday = today.pred_opt().unwrap_or(today);

    let time_str = local.format("%l:%M %p").to_string().trim().to_string();

    if msg_date == today {
        format!("Today at {}", time_str)
    } else if msg_date == yesterday {
        format!("Yesterday at {}", time_str)
    } else if (today - msg_date).num_days() < 7 {
        format!("{} at {}", local.format("%A"), time_str)
    } else {
        local.format("%m/%d/%Y %l:%M %p").to_string().trim().to_string()
    }
}

/// Truncate content to a maximum length, adding ellipsis if truncated
fn truncate_content(content: &str, max_len: usize) -> String {
    if content.len() <= max_len {
        content.to_string()
    } else {
        let truncated: String = content.chars().take(max_len).collect();
        format!("{}...", truncated.trim_end())
    }
}

/// ArticleItem - Collapsed forum-style display for article messages.
///
/// ```
/// +-------------------------------------------------------+
/// |  [Article]  "Understanding OFSCP Protocol"            |
/// |                                                       |
/// |  The OFSCP protocol enables federated communication...|
/// |-------------------------------------------------------|
/// |  [A] alice            Today at 2:30 PM    [Expand >]  |
/// +-------------------------------------------------------+
/// ```
#[component]
pub fn ArticleItem(
    user_id: String,
    created_at: DateTime<Utc>,
    title: Option<String>,
    content: String,
    on_expand: EventHandler<()>,
    is_own_message: bool,
    on_user_click: EventHandler<String>,
) -> Element {
    let auth = use_context::<AuthContext>();
    let user_id_sig = use_signal(|| user_id.clone());

    let profile = use_resource(move || {
        let uid = user_id_sig();
        let auth = auth;
        async move {
            // Extract handle and domain from user_id (format: "handle" or "handle@domain")
            let parts: Vec<&str> = uid.split('@').collect();
            let handle = parts.first().copied().unwrap_or(&uid);
            let domain = parts.get(1).copied();

            let client = auth.client();
            let url = auth.api_url_for_host(domain, &format!("/api/users/{handle}/profile"));
            client
                .get_json::<UserProfile>(&url)
                .await
                .map_err(|e| e.to_string())
        }
    });

    let (display_name, _handle, initial, avatar) = match profile.read().as_ref() {
        Some(Ok(p)) => {
            let name = p.display_name.clone().unwrap_or_else(|| p.handle.clone());
            let init = name.chars().next().unwrap_or('U').to_uppercase().to_string();
            (name, p.handle.clone(), init, p.avatar.clone())
        }
        _ => (
            user_id.clone(),
            user_id.clone(),
            user_id.chars().last().unwrap_or('U').to_uppercase().to_string(),
            None,
        ),
    };

    let formatted_time = format_timestamp(created_at);
    let display_title = title.clone().unwrap_or_else(|| "Untitled Article".to_string());
    let snippet = truncate_content(&content, 150);

    // Card border color based on ownership
    let border_class = if is_own_message {
        "border-indigo-500/30"
    } else {
        "border-[#3f4147]"
    };

    rsx! {
        div { class: "w-full group",
            div {
                class: format!("bg-[#2b2d31] rounded-xl border {} shadow-lg overflow-hidden transition-all cursor-pointer hover:border-[#5865f2] hover:shadow-xl", border_class),
                onclick: move |_| on_expand.call(()),
                // Header with Article badge and title
                div { class: "px-4 pt-4 pb-2",
                    div { class: "flex items-start gap-3",
                        // Article badge
                        span { class: "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[#5865f2]/20 text-[#5865f2] flex-shrink-0",
                            svg {
                                class: "w-3 h-3 mr-1",
                                fill: "none",
                                stroke: "currentColor",
                                view_box: "0 0 24 24",
                                path {
                                    stroke_linecap: "round",
                                    stroke_linejoin: "round",
                                    stroke_width: "2",
                                    d: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
                                }
                            }
                            "Article"
                        }
                        // Title
                        h3 { class: "text-lg font-bold text-white leading-tight flex-1", "\"{display_title}\"" }
                    }
                }
                // Content snippet
                div { class: "px-4 pb-3",
                    p { class: "text-[#b5bac1] text-sm leading-relaxed", "{snippet}" }
                }
                // Footer with author and expand button
                div { class: "flex items-center justify-between px-4 py-3 border-t border-[#3f4147] bg-[#232428]",
                    // Author info
                    div { class: "flex items-center gap-2",
                        // Clickable avatar container
                        div {
                            class: "cursor-pointer flex-shrink-0",
                            onclick: {
                                let uid = user_id.clone();
                                move |e: Event<MouseData>| {
                                    e.stop_propagation();
                                    on_user_click.call(uid.clone());
                                }
                            },
                            // Small avatar with image or gradient fallback
                            if let Some(ref avatar_url) = avatar {
                                img {
                                    class: "w-6 h-6 rounded-full object-cover hover:opacity-80 transition-opacity",
                                    src: "{avatar_url}",
                                    alt: "{display_name}",
                                }
                            } else {
                                div {
                                    class: format!(
                                        "w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-semibold hover:opacity-80 transition-opacity {}",
                                        if is_own_message {
                                            "bg-gradient-to-br from-emerald-500 to-teal-600"
                                        } else {
                                            "bg-gradient-to-br from-indigo-500 to-purple-600"
                                        }
                                    ),
                                    "{initial}"
                                }
                            }
                        }
                        span {
                            class: "text-sm text-[#dbdee1] hover:underline cursor-pointer",
                            onclick: {
                                let uid = user_id.clone();
                                move |e: Event<MouseData>| {
                                    e.stop_propagation();
                                    on_user_click.call(uid.clone());
                                }
                            },
                            "{display_name}"
                        }
                        span { class: "text-xs text-[#b5bac1]", "{formatted_time}" }
                    }
                    // Expand button
                    div { class: "flex items-center gap-1 text-[#5865f2] text-sm font-medium group-hover:text-[#7983f5] transition-colors",
                        "Read more"
                        svg {
                            class: "w-4 h-4 transform group-hover:translate-x-0.5 transition-transform",
                            fill: "none",
                            stroke: "currentColor",
                            view_box: "0 0 24 24",
                            path {
                                stroke_linecap: "round",
                                stroke_linejoin: "round",
                                stroke_width: "2",
                                d: "M9 5l7 7-7 7",
                            }
                        }
                    }
                }
            }
        }
    }
}
