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

    let (display_name, handle, initial, avatar) = match profile.read().as_ref() {
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

    // Card border color based on ownership
    let border_class = if is_own_message {
        "border-indigo-500/30"
    } else {
        "border-[#3f4147]"
    };

    let user_id_for_click = user_id.clone();
    let user_id_for_click2 = user_id.clone();

    rsx! {
        div { class: "w-full group",
            div { class: format!("bg-[#2b2d31] rounded-xl border {} shadow-lg overflow-hidden transition-colors hover:border-[#5865f2]/50", border_class),
                // Header with author info
                div { class: "flex items-center gap-3 px-4 py-3 border-b border-[#3f4147]",
                    // Clickable avatar container
                    div {
                        class: "cursor-pointer flex-shrink-0",
                        onclick: {
                            let uid = user_id_for_click.clone();
                            move |_| on_user_click.call(uid.clone())
                        },
                        // Avatar with image or gradient fallback
                        if let Some(ref avatar_url) = avatar {
                            img {
                                class: "w-10 h-10 rounded-full object-cover shadow-lg hover:opacity-80 transition-opacity",
                                src: "{avatar_url}",
                                alt: "{display_name}",
                            }
                        } else {
                            div {
                                class: format!(
                                    "w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold shadow-lg hover:opacity-80 transition-opacity {}",
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
                    // Author name and handle
                    div { class: "flex-1 min-w-0",
                        div { class: "flex items-baseline gap-2",
                            span {
                                class: "font-semibold text-white text-sm truncate hover:underline cursor-pointer",
                                onclick: {
                                    let uid = user_id_for_click2.clone();
                                    move |_| on_user_click.call(uid.clone())
                                },
                                "{display_name}"
                            }
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
