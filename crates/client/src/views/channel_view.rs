//! Channel view component for displaying chat messages.

use crate::auth_session::AuthContext;
use crate::components::messages::{ArticleItem, ArticleModal, MemoItem};
use crate::hooks::use_refreshable_resource;
use crate::stores::{ChannelMessages, StoredMessage, MESSAGES};
use crate::ws::{get_handle, normalize_host};
use crate::Route;
use chrono::{DateTime, Local, Utc};
use dioxus::logger::tracing;
use dioxus::prelude::*;
use forumall_shared::{Group, MessagesPage, MessageType, UserProfile};

#[derive(Clone)]
pub struct ChannelViewRefresh {
    pub refresh: Signal<()>,
}

/// Channel view component that displays the chat area for a specific channel
/// This is the innermost component in the layout hierarchy
#[component]
pub fn ChannelView(
    group_host: ReadSignal<String>,
    group: ReadSignal<String>,
    channel: ReadSignal<String>,
) -> Element {
    let auth = use_context::<AuthContext>();
    let nav = use_navigator();

    // Fetch the specific group by ID (group name is used as ID) from the correct host
    let group_resource = use_refreshable_resource(move || {
        tracing::info!("ChannelView group refresh");
        let auth = auth.clone();
        let host = group_host.read().clone();
        let group_id = group.read().clone();
        async move {
            let client = auth.client();
            let url = auth.api_url_for_host(Some(&host), &format!("/api/groups/{}", group_id));
            client
                .get_json::<Group>(&url)
                .await
                .map_err(|e| format!("API error: {e:?}"))
        }
    });

    // Get the current group from the resource
    let current_group = use_memo(move || {
        group_resource
            .read()
            .as_ref()
            .and_then(|res| res.as_ref().ok())
            .cloned()
    });

    // Fetch channels to get channel_id from the correct host
    // This resource will automatically update when current_group changes because we read it
    let channels_resource = use_resource(move || {
        let group_id = current_group.read().as_ref().map(|g| g.id.clone());
        let host = group_host.read().clone();
        let auth = auth.clone();
        async move {
            if let Some(group_id) = group_id {
                let client = auth.client();
                let url =
                    auth.api_url_for_host(Some(&host), &format!("/api/groups/{group_id}/channels"));
                client
                    .get_json::<Vec<forumall_shared::Channel>>(&url)
                    .await
                    .map_err(|e| e.to_string())
            } else {
                Err("No group selected".to_string())
            }
        }
    });

    // Find the current channel directly from the resource
    let current_channel = use_memo(move || {
        channels_resource
            .read()
            .as_ref()
            .and_then(|res| res.as_ref().ok())
            .and_then(|channels| channels.iter().find(|c| c.name == *channel.read()).cloned())
    });

    rsx! {
        // Chat Area - overflow-visible to allow dropdowns to escape
        div { class: "flex-1 flex flex-col bg-[#313338] overflow-visible",
            if let Some(channel) = current_channel.read().as_ref() {
                // Channel header
                div { class: "h-12 px-4 flex items-center shadow-sm border-b border-[#232428] justify-between",
                    div { class: "flex items-center",
                        // Back button - visible only on mobile
                        button {
                            class: "md:hidden mr-3 p-1.5 -ml-1 rounded-lg text-gray-400 hover:text-white hover:bg-[#404249] transition-colors",
                            onclick: move |_| {
                                nav.push(Route::NoChannel {
                                    group_host: group_host().clone(),
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
                        group_host: group_host.read().clone(),
                    }
                }
                // Input area - overflow-visible to allow dropdown to escape
                div { class: "px-4 pb-6 overflow-visible relative z-20",
                    MessageInput {
                        group_id: channel.group_id.clone(),
                        channel_id: channel.id.clone(),
                        channel_name: channel.name.clone(),
                        group_host: group_host.read().clone(),
                        allowed_types: channel.settings.message_types.root_types.clone(),
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
                            nav.push(Route::NoGroup {});
                        },
                        "Go Back"
                    }
                }
            }
        }
    }
}

/// State for an expanded article in the modal
#[derive(Clone)]
struct ExpandedArticle {
    user_id: String,
    created_at: DateTime<Utc>,
    title: Option<String>,
    content: String,
}

#[component]
fn MessageList(group_id: String, channel_id: String, group_host: String) -> Element {
    let auth = use_context::<AuthContext>();

    // Compute WebSocket key for subscription
    let local_domain = auth.provider_domain.read().clone();
    let normalized = normalize_host(&group_host);
    let ws_key = if group_host.is_empty() || normalized == normalize_host(&local_domain) {
        String::new()
    } else {
        normalized
    };

    // State for expanded article modal
    let mut expanded_article = use_signal(|| None::<ExpandedArticle>);

    // Track subscribed channel to manage WebSocket subscriptions
    let mut subscribed_channel = use_signal(|| None::<String>);

    // Check if this channel is already loaded in the store
    let store = MESSAGES.resolve();
    let is_loaded = store
        .read()
        .get(&channel_id)
        .map(|ch| ch.is_loaded)
        .unwrap_or(false);

    // Fetch message history if not loaded, then populate the store
    let channel_id_for_fetch = channel_id.clone();
    let group_id_for_fetch = group_id.clone();
    let group_host_for_fetch = group_host.clone();
    let fetch_status = use_resource(move || {
        let cid = channel_id_for_fetch.clone();
        let gid = group_id_for_fetch.clone();
        let host = group_host_for_fetch.clone();
        let auth = auth.clone();
        let already_loaded = is_loaded;
        async move {
            // Skip fetch if already loaded
            if already_loaded {
                return Ok::<(), String>(());
            }

            let client = auth.client();
            let url = auth.api_url_for_host(
                Some(&host),
                &format!("/api/groups/{gid}/channels/{cid}/messages?limit=50&direction=backward"),
            );

            match client.get_json::<MessagesPage>(&url).await {
                Ok(page) => {
                    // Convert to StoredMessage and populate store
                    let messages: Vec<StoredMessage> = page
                        .items
                        .into_iter()
                        .map(|msg| {
                            let created_at = chrono::DateTime::parse_from_rfc3339(&msg.created_at)
                                .map(|dt| dt.with_timezone(&Utc))
                                .unwrap_or_else(|_| Utc::now());

                            StoredMessage {
                                id: msg.id,
                                user_id: msg.sender_user_id,
                                title: msg.title,
                                content: msg.body,
                                message_type: msg.message_type.unwrap_or(MessageType::Message),
                                created_at,
                            }
                        })
                        .collect();

                    // Write to the global store
                    let mut store = MESSAGES.resolve();
                    let mut channel_msgs = ChannelMessages::default();
                    channel_msgs.set_history(messages);
                    store.write().insert(cid, channel_msgs);

                    Ok(())
                }
                Err(e) => Err(e.to_string()),
            }
        }
    });

    // Subscribe to channel via WebSocket when channel changes
    let channel_id_for_sub = channel_id.clone();
    let ws_key_for_sub = ws_key.clone();
    // Note: We still need use_effect for WebSocket subscription management
    // because it involves side effects (subscribe/unsubscribe calls)
    use_effect(move || {
        let target_cid = channel_id_for_sub.clone();
        let key = ws_key_for_sub.clone();

        let mut sub = subscribed_channel.write();
        if sub.as_ref() != Some(&target_cid) {
            // Unsubscribe from previous
            if let Some(old) = sub.take() {
                if let Some(handle) = get_handle(&key) {
                    let _ = handle.unsubscribe(&old);
                }
            }

            // Subscribe to new
            if let Some(handle) = get_handle(&key) {
                let _ = handle.subscribe(&target_cid);
            }
            *sub = Some(target_cid);
        }
    });

    // Function to scroll the messages container to the bottom
    fn do_scroll_to_bottom() {
        #[cfg(target_arch = "wasm32")]
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
        #[cfg(not(target_arch = "wasm32"))]
        {}
    }

    // Read messages from the global store
    let store = MESSAGES.resolve();
    let store_read = store.read();
    let channel_data = store_read.get(&channel_id);

    rsx! {
        // Spacer that grows to push messages to the bottom when they don't fill the container
        div { class: "flex-1" }
        // Messages container
        div { class: "flex flex-col px-4 py-4 gap-3",
            match (channel_data, fetch_status.read().as_ref()) {
                // Channel loaded - render from store
                (Some(ch), _) if ch.is_loaded => {
                    // Scroll to bottom when messages are available
                    do_scroll_to_bottom();
                    rsx! {
                        for msg in ch.messages.iter() {
                            MessageItem {
                                key: "{msg.id}",
                                user_id: msg.user_id.clone(),
                                created_at: msg.created_at,
                                title: msg.title.clone(),
                                content: msg.content.clone(),
                                message_type: msg.message_type.clone(),
                                on_expand_article: move |article: ExpandedArticle| {
                                    expanded_article.set(Some(article));
                                },
                            }
                        }
                    }
                }
                // Fetch failed
                (_, Some(Err(e))) => rsx! {
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
                // Still loading
                _ => rsx! {
                    div { class: "flex items-center justify-center p-8 text-gray-400",
                        div { class: "animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500 mr-3" }
                        "Loading messages..."
                    }
                },
            }
        }
        // Article modal overlay
        if let Some(article) = expanded_article.read().as_ref() {
            ArticleModal {
                user_id: article.user_id.clone(),
                created_at: article.created_at,
                title: article.title.clone(),
                content: article.content.clone(),
                on_close: move |_| {
                    expanded_article.set(None);
                },
            }
        }
    }
}

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
        // Within the last week, show day name
        format!("{} at {}", local.format("%A"), time_str)
    } else {
        // Older than a week, show full date
        local.format("%m/%d/%Y %l:%M %p").to_string().trim().to_string()
    }
}

#[component]
fn MessageItem(
    user_id: String,
    created_at: DateTime<Utc>,
    title: Option<String>,
    content: String,
    message_type: MessageType,
    on_expand_article: EventHandler<ExpandedArticle>,
) -> Element {
    let auth = use_context::<AuthContext>();

    // Check if this message is from the current user
    let is_own_message = auth.user_id().map(|uid| uid == user_id).unwrap_or(false);

    // Route to appropriate component based on message type
    match message_type {
        MessageType::Memo => {
            rsx! {
                MemoItem {
                    user_id: user_id.clone(),
                    created_at,
                    content: content.clone(),
                    is_own_message,
                }
            }
        }
        MessageType::Article => {
            let user_id_for_expand = user_id.clone();
            let title_for_expand = title.clone();
            let content_for_expand = content.clone();
            rsx! {
                ArticleItem {
                    user_id: user_id.clone(),
                    created_at,
                    title: title.clone(),
                    content: content.clone(),
                    is_own_message,
                    on_expand: move |_| {
                        on_expand_article.call(ExpandedArticle {
                            user_id: user_id_for_expand.clone(),
                            created_at,
                            title: title_for_expand.clone(),
                            content: content_for_expand.clone(),
                        });
                    },
                }
            }
        }
        MessageType::Message => {
            // Default chat bubble style
            rsx! {
                ChatBubble {
                    user_id,
                    created_at,
                    title,
                    content,
                    is_own_message,
                }
            }
        }
    }
}

/// Chat bubble component for regular Message type
#[component]
fn ChatBubble(
    user_id: String,
    created_at: DateTime<Utc>,
    title: Option<String>,
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
                        if let Some(ref t) = title {
                            h3 { class: "text-white font-bold text-lg mb-1", "{t}" }
                        }
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
                div { class: "flex flex-col items-start max-w-[85%]",
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
                        if let Some(ref t) = title {
                            h3 { class: "text-white font-bold text-lg mb-1", "{t}" }
                        }
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
fn MessageInput(
    group_id: String,
    channel_id: String,
    channel_name: String,
    group_host: String,
    allowed_types: Vec<MessageType>,
) -> Element {
    let auth = use_context::<AuthContext>();
    let mut text = use_signal(|| String::new());
    let mut title = use_signal(|| String::new());
    let mut message_type = use_signal(|| {
        // Default to first allowed type, or Message if available
        if allowed_types.contains(&MessageType::Message) {
            MessageType::Message
        } else {
            allowed_types.first().cloned().unwrap_or(MessageType::Message)
        }
    });
    let mut show_type_dropdown = use_signal(|| false);

    // Compute websocket key
    let local_domain = auth.provider_domain.read().clone();
    let normalized = normalize_host(&group_host);
    let ws_key = if group_host.is_empty() || normalized == normalize_host(&local_domain) {
        String::new()
    } else {
        normalized
    };

    let is_article = matches!(*message_type.read(), MessageType::Article);
    let allowed_types_for_render = allowed_types.clone();
    let allowed_types_for_submit = allowed_types.clone();

    let onsubmit = move |e: dioxus_core::Event<FormData>| {
        e.prevent_default();

        let body = text.read().clone();
        if body.is_empty() {
            return;
        }

        let current_type = message_type.read().clone();
        let current_title = if matches!(current_type, MessageType::Article) {
            let t = title.read().clone();
            if t.is_empty() { None } else { Some(t) }
        } else {
            None
        };

        // Send via websocket handle with type and title
        let key = ws_key.clone();
        let cid = channel_id.clone();
        crate::log_info!("MessageInput: looking for handle with key '{}'", key);
        if let Some(handle) = get_handle(&key) {
            let nonce = uuid::Uuid::new_v4().to_string();
            crate::log_info!("MessageInput: sending {:?} to channel '{}' with nonce '{}'", current_type, cid, nonce);
            let _ = handle.send_message_with_options(
                &cid,
                &body,
                &nonce,
                current_title,
                Some(current_type.clone()),
            );
        } else {
            crate::log_error!("MessageInput: no handle found for key '{}'", key);
        }
        text.set(String::new());
        title.set(String::new());
        // Reset to Message type if allowed, otherwise keep current type
        if allowed_types_for_submit.contains(&MessageType::Message) {
            message_type.set(MessageType::Message);
        }
    };

    // Get display info for current type
    let type_label = match *message_type.read() {
        MessageType::Message => "Msg",
        MessageType::Memo => "Memo",
        MessageType::Article => "Art",
    };

    rsx! {
        form { onsubmit, class: "relative",
            // Article mode: show title field above
            if is_article {
                div { class: "flex items-center bg-[#383a40] rounded-t-lg border-b border-[#2b2d31] px-3 py-2",
                    input {
                        class: "flex-1 bg-transparent text-white placeholder-[#6d6f78] outline-none text-sm font-medium",
                        r#type: "text",
                        placeholder: "Article title...",
                        value: "{title}",
                        oninput: move |e: FormEvent| title.set(e.value()),
                    }
                }
            }
            div { class: format!("flex items-center bg-[#383a40] {}", if is_article { "rounded-b-lg" } else { "rounded-lg" }),
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
                // Message type selector - using overflow-visible to allow dropdown to escape
                div { class: "relative overflow-visible",
                    button {
                        r#type: "button",
                        class: "flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium bg-[#2b2d31] text-[#b5bac1] hover:text-white hover:bg-[#404249] transition-colors",
                        onclick: move |_| show_type_dropdown.set(!show_type_dropdown()),
                        span { "{type_label}" }
                        svg {
                            class: format!("w-3 h-3 transition-transform {}", if *show_type_dropdown.read() { "rotate-180" } else { "" }),
                            fill: "none",
                            stroke: "currentColor",
                            view_box: "0 0 24 24",
                            path {
                                stroke_linecap: "round",
                                stroke_linejoin: "round",
                                stroke_width: "2",
                                d: "M19 9l-7 7-7-7",
                            }
                        }
                    }
                    // Dropdown menu - positioned above with high z-index
                    if *show_type_dropdown.read() {
                        // Invisible backdrop to catch clicks outside
                        div {
                            class: "fixed inset-0 z-[99]",
                            onclick: move |_| show_type_dropdown.set(false),
                        }
                        div {
                            class: "absolute left-0 bg-[#1e1f22] rounded-lg shadow-2xl border border-[#3f4147] py-1 min-w-[140px] z-[100]",
                            style: "bottom: 100%; margin-bottom: 8px;",
                            for msg_type in [MessageType::Message, MessageType::Memo, MessageType::Article].iter() {
                                {
                                    let msg_type_clone = msg_type.clone();
                                    let is_allowed = allowed_types_for_render.contains(msg_type);
                                    let is_selected = *message_type.read() == *msg_type;
                                    let (label, description) = match msg_type {
                                        MessageType::Message => ("Message", "Chat bubble"),
                                        MessageType::Memo => ("Memo", "Post-style card"),
                                        MessageType::Article => ("Article", "Forum-style post"),
                                    };
                                    rsx! {
                                        button {
                                            key: "{label}",
                                            r#type: "button",
                                            disabled: !is_allowed,
                                            class: format!(
                                                "w-full px-3 py-2 text-left transition-colors {}",
                                                if !is_allowed {
                                                    "opacity-40 cursor-not-allowed"
                                                } else if is_selected {
                                                    "bg-indigo-500/20 text-white"
                                                } else {
                                                    "text-[#dbdee1] hover:bg-[#404249]"
                                                }
                                            ),
                                            onclick: move |_| {
                                                if is_allowed {
                                                    message_type.set(msg_type_clone.clone());
                                                    show_type_dropdown.set(false);
                                                }
                                            },
                                            div { class: "flex flex-col",
                                                span { class: "text-sm font-medium", "{label}" }
                                                span { class: "text-xs text-[#b5bac1]", "{description}" }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                // Input
                input {
                    class: "flex-1 bg-transparent text-[#dbdee1] placeholder-[#6d6f78] py-3 px-3 outline-none",
                    r#type: "text",
                    placeholder: format!("{} #{}", if is_article { "Write your article for" } else { "Message" }, channel_name),
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
