//! Article modal component - full article view overlay.

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

/// ArticleModal - Full-screen overlay for viewing complete article content.
///
/// ```
/// +---------------------------------------------------------------+
/// |  [X] Close                                                    |
/// |---------------------------------------------------------------|
/// |  "Understanding the OFSCP Protocol"                           |
/// |  [A] alice  @alice                        Today at 2:30 PM    |
/// |---------------------------------------------------------------|
/// |                                                               |
/// |  Full article content rendered here...                        |
/// |                                                               |
/// +---------------------------------------------------------------+
/// ```
#[component]
pub fn ArticleModal(
    user_id: String,
    created_at: DateTime<Utc>,
    title: Option<String>,
    content: String,
    on_close: EventHandler<()>,
) -> Element {
    let auth = use_context::<AuthContext>();
    let user_id_sig = use_signal(|| user_id.clone());

    let profile = use_resource(move || {
        let uid = user_id_sig();
        let auth = auth;
        async move {
            let client = auth.client();
            let url = auth.api_url(&format!("/api/users/{uid}/profile"));
            client
                .get_json::<UserProfile>(&url)
                .await
                .map_err(|e| e.to_string())
        }
    });

    let (handle, initial) = match profile.read().as_ref() {
        Some(Ok(p)) => (
            p.handle.clone(),
            p.handle
                .chars()
                .next()
                .unwrap_or('U')
                .to_uppercase()
                .to_string(),
        ),
        _ => (
            user_id.clone(),
            user_id
                .chars()
                .last()
                .unwrap_or('U')
                .to_uppercase()
                .to_string(),
        ),
    };

    let formatted_time = format_timestamp(created_at);
    let display_title = title.unwrap_or_else(|| "Untitled Article".to_string());

    rsx! {
        // Backdrop
        div {
            class: "fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm",
            onclick: move |_| on_close.call(()),
            // Modal container
            div {
                class: "relative w-full max-w-3xl max-h-[90vh] mx-4 bg-[#2b2d31] rounded-xl shadow-2xl flex flex-col overflow-hidden",
                onclick: move |e| e.stop_propagation(),
                // Header
                div { class: "flex items-center justify-between px-6 py-4 border-b border-[#3f4147]",
                    // Close button
                    button {
                        class: "flex items-center gap-2 text-[#b5bac1] hover:text-white transition-colors",
                        onclick: move |_| on_close.call(()),
                        svg {
                            class: "w-5 h-5",
                            fill: "none",
                            stroke: "currentColor",
                            view_box: "0 0 24 24",
                            path {
                                stroke_linecap: "round",
                                stroke_linejoin: "round",
                                stroke_width: "2",
                                d: "M6 18L18 6M6 6l12 12",
                            }
                        }
                        span { class: "text-sm font-medium", "Close" }
                    }
                    // Article badge
                    span { class: "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[#5865f2]/20 text-[#5865f2]",
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
                }
                // Title and author section
                div { class: "px-6 py-4 border-b border-[#3f4147]",
                    h1 { class: "text-2xl font-bold text-white mb-3", "{display_title}" }
                    div { class: "flex items-center gap-3",
                        // Avatar
                        div { class: "w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-semibold flex-shrink-0 shadow-lg",
                            "{initial}"
                        }
                        div { class: "flex flex-col",
                            div { class: "flex items-baseline gap-2",
                                span { class: "font-semibold text-white", "{handle}" }
                                span { class: "text-sm text-[#b5bac1]", "@{handle}" }
                            }
                            span { class: "text-xs text-[#b5bac1]", "{formatted_time}" }
                        }
                    }
                }
                // Content - scrollable
                div { class: "flex-1 overflow-y-auto px-6 py-6",
                    div { class: "prose prose-invert max-w-none",
                        p { class: "text-[#dbdee1] leading-relaxed whitespace-pre-wrap break-words text-base", "{content}" }
                    }
                }
            }
        }
    }
}
