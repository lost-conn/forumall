//! Memo message component - post-style card layout.

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

/// MemoItem - Post-style card display for memo messages.
///
/// ```
/// +-------------------------------------------------------+
/// |  [A]  alice  @alice                   Today at 2:30 PM|
/// |-------------------------------------------------------|
/// |                                                       |
/// |  This is a memo post displayed as a full-width card  |
/// |  with author info at top and content below.          |
/// |                                                       |
/// +-------------------------------------------------------+
/// ```
#[component]
pub fn MemoItem(
    user_id: String,
    created_at: DateTime<Utc>,
    content: String,
    is_own_message: bool,
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

    // Card border color based on ownership
    let border_class = if is_own_message {
        "border-indigo-500/30"
    } else {
        "border-[#3f4147]"
    };

    rsx! {
        div { class: "w-full group",
            div { class: format!("bg-[#2b2d31] rounded-xl border {} shadow-lg overflow-hidden transition-colors hover:border-[#5865f2]/50", border_class),
                // Header with author info
                div { class: "flex items-center gap-3 px-4 py-3 border-b border-[#3f4147]",
                    // Avatar
                    div {
                        class: format!(
                            "w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold flex-shrink-0 shadow-lg {}",
                            if is_own_message {
                                "bg-gradient-to-br from-emerald-500 to-teal-600"
                            } else {
                                "bg-gradient-to-br from-indigo-500 to-purple-600"
                            }
                        ),
                        "{initial}"
                    }
                    // Author name and handle
                    div { class: "flex-1 min-w-0",
                        div { class: "flex items-baseline gap-2",
                            span { class: "font-semibold text-white text-sm truncate", "{handle}" }
                            span { class: "text-xs text-[#b5bac1]", "@{handle}" }
                        }
                    }
                    // Timestamp
                    span { class: "text-xs text-[#b5bac1] flex-shrink-0", "{formatted_time}" }
                }
                // Content
                div { class: "px-4 py-4",
                    p { class: "text-[#dbdee1] leading-relaxed whitespace-pre-wrap break-words", "{content}" }
                }
            }
        }
    }
}
