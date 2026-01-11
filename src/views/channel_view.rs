use crate::auth_session::AuthContext;
use crate::hooks::use_refreshable_resource;
use crate::messages::*;
use crate::models::{ClientCommand, ServerEvent, WsEnvelope};
use crate::ws_client::use_ws;
use chrono::{DateTime, Local, Utc};
use dioxus::logger::tracing;
use dioxus::prelude::*;
use dioxus_fullstack::Json;

#[derive(Clone)]
pub struct ChannelViewRefresh {
    pub refresh: Signal<()>,
}

/// Channel view component that displays the chat area for a specific channel
/// This is the innermost component in the layout hierarchy
#[component]
pub fn ChannelView(group: ReadSignal<String>, channel: ReadSignal<String>) -> Element {
    let auth = use_context::<AuthContext>();

    let nav = use_navigator();

    // Fetch group data to get group_id
    let groups_resource = use_refreshable_resource(move || {
        tracing::info!("ChannelView group refresh");
        let auth = auth.clone();
        async move {
            let token = auth.token();
            if token.is_none() {
                return Err(ServerFnError::new("Not authenticated"));
            }
            let client = auth.client();
            let url = auth.api_url("/api/groups");
            client
                .get_json::<Vec<crate::groups::Group>>(&url)
                .await
                .map_err(|e| ServerFnError::new(format!("API error: {e:?}")))
        }
    });

    // Find the current group directly from the resource
    let current_group = use_memo(move || {
        groups_resource
            .read()
            .as_ref()
            .and_then(|res| res.as_ref().ok())
            .and_then(|groups| groups.iter().find(|g| g.name == *group.read()).cloned())
    });

    // Fetch channels to get channel_id
    // This resource will automatically update when current_group changes because we read it
    let channels_resource = use_resource(move || {
        let group_id = current_group.read().as_ref().map(|g| g.id.clone());
        let auth = auth.clone();
        async move {
            if let Some(group_id) = group_id {
                let token = auth.token();
                if token.is_none() {
                    return Err(ServerFnError::new("Not authenticated"));
                }

                let client = auth.client();
                let url = auth.api_url(&format!("/api/groups/{group_id}/channels"));
                client
                    .get_json::<Vec<crate::groups::Channel>>(&url)
                    .await
                    .map(Json)
                    .map_err(|e| ServerFnError::new(e.to_string()))
            } else {
                Err(ServerFnError::new("No group selected"))
            }
        }
    });

    // Find the current channel directly from the resource
    let current_channel = use_memo(move || {
        channels_resource
            .read()
            .as_ref()
            .and_then(|res| res.as_ref().ok())
            .and_then(|channels| {
                channels
                    .0
                    .iter()
                    .find(|c| c.name == *channel.read())
                    .cloned()
            })
    });

    rsx! {
        // Chat Area
        div { class: "flex-1 flex flex-col bg-[#313338]",
            if let Some(channel) = current_channel.read().as_ref() {
                // Channel header
                div { class: "h-12 px-4 flex items-center shadow-sm border-b border-[#232428] justify-between",
                    div { class: "flex items-center",
                        // Back button - visible only on mobile
                        button {
                            class: "md:hidden mr-3 p-1.5 -ml-1 rounded-lg text-gray-400 hover:text-white hover:bg-[#404249] transition-colors",
                            onclick: move |_| {
                                nav.push(crate::Route::NoChannel {
                                    group: group().clone(),
                                });
                            },
                            svg {
                                class: "w-5 h-5",
                                fill: "none",
                                stroke: "currentColor",
                                view_box: "0 0 24 24",
                                path {
                                    stroke_linecap: "round",
                                    stroke_linejoin: "round",
                                    stroke_width: "2",
                                    d: "M15 19l-7-7 7-7",
                                }
                            }
                        }
                        span { class: "text-[#80848e] text-xl mr-2", "#" }
                        span { class: "font-semibold text-white", "{channel.name}" }
                        if let Some(topic) = &channel.topic {
                            div { class: "w-px h-6 bg-[#3f4147] mx-4 hidden sm:block" }
                            span { class: "text-sm text-gray-400 truncate hidden sm:block", "{topic}" }
                        }
                    }
                }
                // Messages - container with flex-col-reverse to anchor at bottom
                div {
                    id: "messages-container",
                    class: "flex-1 overflow-y-auto flex flex-col",
                    MessageList {
                        group_id: channel.group_id.clone(),
                        channel_id: channel.id.clone(),
                    }
                }
                // Input area
                div { class: "px-4 pb-6",
                    MessageInput {
                        group_id: channel.group_id.clone(),
                        channel_id: channel.id.clone(),
                        channel_name: channel.name.clone(),
                    }
                }
            } else {
                // Empty state with gradient background
                div { class: "flex-1 flex flex-col items-center justify-center bg-gradient-to-b from-[#313338] to-[#2b2d31]",
                    // Glowing icon container
                    div { class: "relative mb-8",
                        // Glow effect
                        div { class: "absolute inset-0 bg-gradient-to-br from-indigo-500/20 to-purple-600/20 rounded-full blur-2xl scale-150" }
                        // Icon
                        div { class: "relative w-24 h-24 bg-gradient-to-br from-[#3f4147] to-[#2b2d31] rounded-3xl flex items-center justify-center shadow-lg",
                            svg {
                                class: "w-12 h-12 text-gray-400",
                                fill: "currentColor",
                                view_box: "0 0 24 24",
                                path { d: "M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" }
                            }
                        }
                    }
                    h2 { class: "text-2xl font-bold text-white mb-2", "Channel Not Found" }
                    p { class: "text-gray-400 text-center max-w-md",
                        "The channel '{channel}' does not exist in group '{group}'"
                    }
                    button {
                        class: "mt-4 px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg transition-colors",
                        onclick: move |_| {
                            nav.push(crate::Route::NoGroup {});
                        },
                        "Go Back"
                    }
                }
            }
        }
    }
}

#[component]
fn MessageList(group_id: String, channel_id: String) -> Element {
    let auth = use_context::<AuthContext>();
    let ws_ctx = use_ws();

    // Track props to ensure resource reactivity
    let mut track_group_id = use_signal(|| group_id.clone());
    let mut track_channel_id = use_signal(|| channel_id.clone());
    let mut realtime_msgs = use_signal(|| Vec::<TimelineItem>::new());
    let mut subscribed_channel = use_signal(|| None::<String>);

    if track_group_id() != group_id {
        track_group_id.set(group_id.clone());
    }
    if track_channel_id() != channel_id {
        track_channel_id.set(channel_id.clone());
        realtime_msgs.set(Vec::new()); // Clear realtime messages on channel switch
    }

    // Subscribe to channel via WebSocket
    let cid_sig = track_channel_id;
    use_effect(move || {
        let target_cid = cid_sig();
        let ws = ws_ctx.ws;

        spawn(async move {
            let mut sub = subscribed_channel.write();
            if sub.as_ref() != Some(&target_cid) {
                // Unsubscribe from previous
                if let Some(old) = sub.take() {
                    let msg = WsEnvelope {
                        id: uuid::Uuid::new_v4().to_string(),
                        ts: chrono::Utc::now(),
                        payload: ClientCommand::Unsubscribe { channel_id: old },
                        correlation_id: None,
                    };
                    _ = ws.send(msg).await;
                }

                // Subscribe to new
                let msg = WsEnvelope {
                    id: uuid::Uuid::new_v4().to_string(),
                    ts: chrono::Utc::now(),
                    payload: ClientCommand::Subscribe {
                        channel_id: target_cid.clone(),
                    },
                    correlation_id: None,
                };
                if ws.send(msg).await.is_ok() {
                    *sub = Some(target_cid);
                }
            }
        });
    });

    // Listen for new messages
    use_effect(move || {
        if let Some(env) = (ws_ctx.last_event)() {
            if let ServerEvent::MessageNew { message } = env.payload {
                // Convert model message to timeline item
                let m = crate::messages::BaseMessage {
                    id: message.id,
                    author: crate::messages::UserRef {
                        id: match message.author {
                            crate::models::UserRef::Handle(h) => h,
                            crate::models::UserRef::Uri(u) => u,
                        },
                    },
                    kind: "message".to_string(),
                    content: crate::messages::Content {
                        text: message.content.text,
                        mime: message.content.mime,
                    },
                    attachments: vec![],
                    createdAt: message.created_at.to_rfc3339(),
                    metadata: vec![],
                };
                realtime_msgs.write().push(TimelineItem::Message(m));
            }
        }
    });

    let messages = use_resource(move || {
        let gid = track_group_id();
        let cid = track_channel_id();
        let auth = auth.clone();
        async move {
            let token = auth.token();
            if token.is_none() {
                return Err(ServerFnError::new("Not authenticated"));
            }

            let client = auth.client();
            let url = auth.api_url(&format!(
                "/api/groups/{gid}/channels/{cid}/messages?limit=50&direction=backward"
            ));
            client
                .get_json::<MessagesPage>(&url)
                .await
                .map(Json)
                .map_err(|e| ServerFnError::new(e.to_string()))
        }
    });

    // Function to scroll the messages container to the bottom
    fn do_scroll_to_bottom() {
        #[cfg(feature = "web")]
        {
            if let Some(window) = web_sys::window() {
                if let Some(document) = window.document() {
                    if let Some(container) = document.get_element_by_id("messages-container") {
                        let scroll_height = container.scroll_height();
                        container.set_scroll_top(scroll_height);
                    }
                }
            }
        }
    }

    // Scroll to bottom when messages load
    use_effect(move || {
        if messages.read().is_some() {
            do_scroll_to_bottom();
        }
    });

    // Scroll to bottom when new realtime messages arrive
    use_effect(move || {
        let _ = realtime_msgs.read();
        do_scroll_to_bottom();
    });

    rsx! {
        // Spacer that grows to push messages to the bottom when they don't fill the container
        div { class: "flex-1" }
        // Messages container
        div { class: "flex flex-col px-4 py-4 gap-3",
            match messages.read().as_ref() {
                Some(Ok(page)) => rsx! {
                    for item in page.0.items.iter().chain(realtime_msgs.read().iter()) {
                        match item {
                            TimelineItem::Message(msg) => rsx! {
                                MessageItem {
                                    key: "{msg.id}",
                                    user_id: msg.author.id.split('/').last().unwrap_or("Unknown").to_string(),
                                    created_at: msg.createdAt.clone(),
                                    content: msg.content.text.clone(),
                                }
                            },
                        }
                    }
                },
                Some(Err(e)) => rsx! {
                    div { class: "flex items-center justify-center p-8 text-red-400 bg-red-900/10 rounded-xl",
                        svg {
                            class: "w-6 h-6 mr-2",
                            fill: "none",
                            stroke: "currentColor",
                            view_box: "0 0 24 24",
                            path {
                                stroke_linecap: "round",
                                stroke_linejoin: "round",
                                stroke_width: "2",
                                d: "M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
                            }
                        }
                        "Failed to load messages: {e}"
                    }
                },
                None => rsx! {
                    div { class: "flex items-center justify-center p-8 text-gray-400",
                        div { class: "animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500 mr-3" }
                        "Loading messages..."
                    }
                },
            }
        }
    }
}

/// Format a timestamp string into a human-readable format
fn format_timestamp(created_at: &str) -> String {
    let parsed: Result<DateTime<Utc>, _> = created_at.parse();
    match parsed {
        Ok(dt) => {
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
                // Within the last week, show day name
                format!("{} at {}", local.format("%A"), time_str)
            } else {
                // Older than a week, show full date
                format!("{}", local.format("%m/%d/%Y %l:%M %p").to_string().trim())
            }
        }
        Err(_) => created_at.to_string(),
    }
}

#[component]
fn MessageItem(user_id: String, created_at: String, content: String) -> Element {
    let auth = use_context::<AuthContext>();
    let user_id_sig = use_signal(|| user_id.clone());

    // Check if this message is from the current user
    let is_own_message = auth.user_id().map(|uid| uid == user_id).unwrap_or(false);

    let profile = use_resource(move || {
        let uid = user_id_sig();
        let auth = auth;
        async move {
            let client = auth.client();
            let url = auth.api_url(&format!("/api/users/{uid}/profile"));
            client
                .get_json::<crate::models::UserProfile>(&url)
                .await
                .map(Json)
                .map_err(|e| ServerFnError::new(e.to_string()))
        }
    });

    let (handle, initial) = match profile.read().as_ref() {
        Some(Ok(Json(p))) => (
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

    let formatted_time = format_timestamp(&created_at);

    if is_own_message {
        // Own message: right-aligned on mobile, left-aligned on desktop, with distinct color
        rsx! {
            // Container: flex-row-reverse on mobile, normal row on md+
            div { class: "flex items-start gap-3 group flex-row-reverse md:flex-row",
                // Avatar with gradient (teal/emerald for own messages)
                div { class: "w-10 h-10 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white font-semibold flex-shrink-0 shadow-lg",
                    "{initial}"
                }
                // Message bubble container
                div { class: "flex flex-col items-end md:items-start max-w-[85%]",
                    // Header: reversed on mobile, normal on md+
                    div { class: "flex items-baseline gap-2 mb-1 flex-row-reverse md:flex-row",
                        span { class: "font-semibold text-white hover:underline cursor-pointer text-sm",
                            "{handle}"
                        }
                        span { class: "text-xs text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity",
                            "{formatted_time}"
                        }
                    }
                    // Chat bubble with indigo/purple gradient for own messages
                    div { class: "inline-block bg-gradient-to-br from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 rounded-2xl rounded-tl-md px-4 py-2.5 shadow-md transition-colors",
                        p { class: "text-white leading-relaxed break-words", "{content}" }
                    }
                    // Timestamp below bubble (visible on mobile)
                    span { class: "text-[10px] text-gray-600 mt-1 block md:hidden",
                        "{formatted_time}"
                    }
                }
            }
        }
    } else {
        // Other users: always left-aligned with standard color
        rsx! {
            div { class: "flex items-start gap-3 group",
                // Avatar with gradient
                div { class: "w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-semibold flex-shrink-0 shadow-lg",
                    "{initial}"
                }
                // Message bubble container - using inline-block for variable width
                div { class: "flex flex-col max-w-[85%]",
                    div { class: "flex items-baseline gap-2 mb-1",
                        span { class: "font-semibold text-white hover:underline cursor-pointer text-sm",
                            "{handle}"
                        }
                        span { class: "text-xs text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity",
                            "{formatted_time}"
                        }
                    }
                    // Chat bubble with subtle background - inline-block for variable width
                    div { class: "inline-block bg-[#383a40] hover:bg-[#3f4147] rounded-2xl rounded-tl-md px-4 py-2.5 shadow-md transition-colors",
                        p { class: "text-[#dbdee1] leading-relaxed break-words", "{content}" }
                    }
                    // Timestamp below bubble (visible on mobile)
                    span { class: "text-[10px] text-gray-600 mt-1 block md:hidden",
                        "{formatted_time}"
                    }
                }
            }
        }
    }
}

#[component]
fn MessageInput(group_id: String, channel_id: String, channel_name: String) -> Element {
    let mut text = use_signal(|| String::new());
    let ws = crate::ws_client::use_ws().ws;

    let onsubmit = move |e: dioxus_core::Event<FormData>| {
        e.prevent_default();

        let cid = channel_id.clone();
        let body = text.read().clone();
        if body.is_empty() {
            return;
        }

        spawn(async move {
            let msg = crate::models::WsEnvelope {
                id: uuid::Uuid::new_v4().to_string(),
                ts: chrono::Utc::now(),
                payload: crate::models::ClientCommand::MessageCreate {
                    channel_id: cid,
                    body,
                    nonce: uuid::Uuid::new_v4().to_string(),
                },
                correlation_id: None,
            };
            _ = ws.send(msg).await;
            text.set(String::new());
        });
    };

    rsx! {
        form { onsubmit, class: "relative",
            div { class: "flex items-center bg-[#383a40] rounded-lg",
                // Plus button for attachments
                button {
                    r#type: "button",
                    class: "p-3 text-[#b5bac1] hover:text-[#dbdee1] transition-colors",
                    svg {
                        class: "w-6 h-6",
                        fill: "none",
                        stroke: "currentColor",
                        view_box: "0 0 24 24",
                        path {
                            stroke_linecap: "round",
                            stroke_linejoin: "round",
                            stroke_width: "2",
                            d: "M12 4v16m8-8H4",
                        }
                    }
                }
                // Input
                input {
                    class: "flex-1 bg-transparent text-[#dbdee1] placeholder-[#6d6f78] py-3 pr-4 outline-none",
                    r#type: "text",
                    placeholder: "Message #{channel_name}",
                    value: "{text}",
                    oninput: move |e: FormEvent| text.set(e.value()),
                }
                // Send button
                button {
                    r#type: "submit",
                    class: "p-3 text-[#b5bac1] hover:text-[#dbdee1] transition-colors",
                    svg {
                        class: "w-6 h-6",
                        fill: "none",
                        stroke: "currentColor",
                        view_box: "0 0 24 24",
                        path {
                            stroke_linecap: "round",
                            stroke_linejoin: "round",
                            stroke_width: "2",
                            d: "M12 19l9 2-9-18-9 18 9-2zm0 0v-8",
                        }
                    }
                }
            }
        }
    }
}
