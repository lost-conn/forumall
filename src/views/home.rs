use crate::api_client::ApiClient;
use crate::auth_session::AuthContext;
use crate::groups::*;
use crate::hooks::use_refresh_resource;
use dioxus::prelude::*;
use dioxus_fullstack::Json;

/// Home component that redirects to /home
#[component]
pub fn Home() -> Element {
    let nav = use_navigator();

    use_effect(move || {
        nav.push(crate::Route::NoGroup {});
    });

    rsx! {
        div { class: "flex items-center justify-center min-h-screen bg-[#313338] text-white",
            "Redirecting..."
        }
    }
}

/// Component shown when no group is selected
#[component]
pub fn NoGroup() -> Element {
    rsx! {
        div { class: "flex-1 flex flex-col items-center justify-center bg-[#313338] text-white p-8",
            div { class: "w-20 h-20 bg-[#2b2d31] rounded-full flex items-center justify-center mb-6 text-gray-400",
                svg {
                    class: "w-10 h-10",
                    fill: "none",
                    stroke: "currentColor",
                    view_box: "0 0 24 24",
                    path {
                        stroke_linecap: "round",
                        stroke_linejoin: "round",
                        stroke_width: "1.5",
                        d: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z",
                    }
                }
            }
            h2 { class: "text-2xl font-bold mb-2", "Welcome to Forumall" }
            p { class: "text-gray-400 text-center max-w-md",
                "Select a group from the sidebar on the left to start chatting, or create your own group to invite friends."
            }
        }
    }
}

/// Component shown when a group is selected but no channel is selected
#[component]
pub fn NoChannel(group: String) -> Element {
    rsx! {
        div { class: "flex-1 flex flex-col items-center justify-center bg-[#313338] text-white p-8",
            div { class: "w-20 h-20 bg-[#2b2d31] rounded-full flex items-center justify-center mb-6 text-gray-400",
                svg {
                    class: "w-10 h-10",
                    fill: "none",
                    stroke: "currentColor",
                    view_box: "0 0 24 24",
                    path {
                        stroke_linecap: "round",
                        stroke_linejoin: "round",
                        stroke_width: "1.5",
                        d: "M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z",
                    }
                }
            }
            h2 { class: "text-2xl font-bold mb-2", "No Channel Selected" }
            p { class: "text-gray-400 text-center max-w-md",
                "Pick a channel from the list on the left to join the conversation."
            }
        }
    }
}

/// Channel list component for displaying channels in a group
#[component]
pub fn ChannelList(
    group_id: String,
    group_name: String,
    selected_channel_name: Option<String>,
    on_select: EventHandler<Channel>,
    on_add_channel: EventHandler<()>,
) -> Element {
    let auth = use_context::<AuthContext>();

    // Create a signal to track the group_id prop, ensuring the resource re-runs when it changes
    let mut track_group_id = use_signal(|| group_id.clone());
    if track_group_id() != group_id {
        track_group_id.set(group_id.clone());
    }

    let channels = use_resource(move || {
        let gid = track_group_id();
        let auth = auth.clone();
        async move {
            let token = auth.token();
            if token.is_none() {
                return Err(ServerFnError::new("Not authenticated"));
            }

            let client = ApiClient::new(token);
            let url = auth.api_url(&format!("/api/groups/{gid}/channels"));
            client
                .get_json::<Vec<Channel>>(&url)
                .await
                .map(Json)
                .map_err(|e| ServerFnError::new(e.to_string()))
        }
    });

    rsx! {
        div { class: "space-y-0.5",
            match channels.read().as_ref() {
                Some(Ok(channels)) => rsx! {
                    if channels.0.is_empty() {
                        div { class: "px-4 py-2 text-gray-500 text-xs italic", "No channels yet" }
                    } else {
                        for channel in channels.0.iter() {
                            div {
                                key: "{channel.id}",
                                class: format!(
                                    "group flex items-center px-2 py-1.5 mx-2 rounded cursor-pointer transition-colors {}",
                                    if selected_channel_name.as_ref() == Some(&channel.name) {
                                        "bg-[#404249] text-white"
                                    } else {
                                        "text-[#949ba4] hover:bg-[#35373c] hover:text-[#dbdee1]"
                                    },
                                ),
                                onclick: {
                                    let channel = channel.clone();
                                    let group_name = group_name.clone();
                                    move |_| {
                                        // Navigate to the channel route
                                        let nav = use_navigator();
                                        nav.push(crate::Route::ChannelView {
                                            group: group_name.clone(),
                                            channel: channel.name.clone(),
                                        });
                                        // Also call the on_select handler
                                        on_select.call(channel.clone());
                                    }
                                },
                                span { class: "text-lg mr-1.5 opacity-60", "#" }
                                span { class: "text-sm font-medium truncate", "{channel.name}" }
                            }
                        }
                    }
                },
                Some(Err(e)) => rsx! {
                    div { class: "px-4 py-2 text-red-500 text-xs", "Error: {e}" }
                },
                None => rsx! {
                    div { class: "px-4 py-2 text-gray-500 text-xs", "Loading channels..." }
                },
            }
            // Add channel button
            div {
                class: "flex items-center px-2 py-1.5 mx-2 rounded cursor-pointer text-[#949ba4] hover:text-[#dbdee1] transition-colors",
                onclick: move |_| on_add_channel.call(()),
                svg {
                    class: "w-4 h-4 mr-1.5",
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
                span { class: "text-sm", "Add Channel" }
            }
        }
    }
}

/// Modal for creating a new group
#[component]
pub fn CreateGroupModal(on_close: EventHandler<()>, on_created: EventHandler<()>) -> Element {
    let auth = use_context::<AuthContext>();
    let mut name = use_signal(|| String::new());
    let mut error = use_signal(|| None::<String>);
    let mut is_loading = use_signal(|| false);

    let handle_submit = move |e: FormEvent| {
        e.prevent_default();
        let group_name = name.read().trim().to_string();
        if group_name.is_empty() {
            error.set(Some("Group name is required".to_string()));
            return;
        }

        if !crate::models::validate_resource_name(&group_name) {
            error.set(Some("Invalid group name. Must be lowercase alphanumeric, periods, underscores, or dashes.".to_string()));
            return;
        }

        is_loading.set(true);
        let on_created = on_created.clone();
        let auth = auth.clone();

        spawn(async move {
            let token = auth.token();

            let client = ApiClient::new(token);
            let url = auth.api_url("/api/groups");
            match client
                .post_json::<_, Group>(
                    &url,
                    &CreateGroupRequest {
                        name: group_name,
                        description: None,
                        join_policy: Some("open".to_string()),
                    },
                )
                .await
            {
                Ok(_) => {
                    on_created.call(());
                }
                Err(err) => {
                    let msg = if let crate::api_client::ApiError::Http { body, .. } = &err {
                        crate::problem::try_problem_detail(body)
                            .unwrap_or_else(|| format!("{}", err))
                    } else {
                        format!("{}", err)
                    };
                    error.set(Some(msg));
                    is_loading.set(false);
                }
            }
        });
    };

    rsx! {
        div { class: "fixed inset-0 bg-black/70 flex items-center justify-center z-50",
            div { class: "bg-[#313338] rounded-lg shadow-2xl w-full max-w-md mx-4",
                // Header
                div { class: "px-6 py-4 border-b border-[#3f4147]",
                    h3 { class: "text-xl font-bold text-white", "Create Group" }
                    p { class: "text-sm text-gray-400 mt-1",
                        "Groups are where you organize your channels and conversations"
                    }
                }
                // Form
                form { onsubmit: handle_submit,
                    div { class: "p-6 space-y-4",
                        div {
                            label { class: "block text-sm font-medium text-gray-300 mb-2",
                                "Group Name"
                            }
                            input {
                                class: "w-full bg-[#2b2d31] border border-[#3f4147] rounded-lg px-4 py-3 text-white placeholder-[#6d6f78] focus:outline-none focus:border-indigo-500 transition-colors",
                                r#type: "text",
                                placeholder: "My Awesome Group",
                                value: "{name}",
                                oninput: move |e: FormEvent| {
                                    name.set(e.value());
                                    error.set(None);
                                },
                            }
                        }
                        if let Some(err) = error.read().as_ref() {
                            div { class: "p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm",
                                "{err}"
                            }
                        }
                    }
                    // Footer
                    div { class: "px-6 py-4 border-t border-[#3f4147] flex justify-end gap-3",
                        button {
                            r#type: "button",
                            class: "px-4 py-2 text-gray-300 hover:text-white transition-colors",
                            onclick: move |_| on_close.call(()),
                            "Cancel"
                        }
                        button {
                            r#type: "submit",
                            class: "px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                            disabled: *is_loading.read(),
                            if *is_loading.read() {
                                "Creating..."
                            } else {
                                "Create Group"
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Modal for creating a new channel
#[component]
pub fn CreateChannelModal(
    group_id: String,
    group_name: String,
    on_close: EventHandler<()>,
    on_created: EventHandler<()>,
) -> Element {
    let auth = use_context::<AuthContext>();
    let mut name = use_signal(|| String::new());
    let mut topic = use_signal(|| String::new());
    let mut error = use_signal(|| None::<String>);
    let mut is_loading = use_signal(|| false);

    let handle_submit = move |e: FormEvent| {
        e.prevent_default();
        let channel_name = name.read().trim().to_string();
        if channel_name.is_empty() {
            error.set(Some("Channel name is required".to_string()));
            return;
        }

        if !crate::models::validate_resource_name(&channel_name) {
            error.set(Some("Invalid channel name. Must be lowercase alphanumeric, periods, underscores, or dashes.".to_string()));
            return;
        }

        is_loading.set(true);
        let on_created = on_created.clone();
        let gid = group_id.clone();
        let topic_value = topic.read().trim().to_string();
        let auth = auth.clone();
        spawn(async move {
            let token = auth.token();
            let client = ApiClient::new(token);
            let url = auth.api_url(&format!("/api/groups/{gid}/channels"));
            match client
                .post_json::<_, Channel>(
                    &url,
                    &CreateChannelRequest {
                        name: channel_name,
                        topic: if topic_value.is_empty() {
                            None
                        } else {
                            Some(topic_value)
                        },
                    },
                )
                .await
            {
                Ok(_) => {
                    on_created.call(());
                }
                Err(err) => {
                    let msg = if let crate::api_client::ApiError::Http { body, .. } = &err {
                        crate::problem::try_problem_detail(body)
                            .unwrap_or_else(|| format!("{}", err))
                    } else {
                        format!("{}", err)
                    };
                    error.set(Some(msg));
                    is_loading.set(false);
                }
            }
        });
    };

    rsx! {
        div { class: "fixed inset-0 bg-black/70 flex items-center justify-center z-50",
            div { class: "bg-[#313338] rounded-lg shadow-2xl w-full max-w-md mx-4",
                // Header
                div { class: "px-6 py-4 border-b border-[#3f4147]",
                    h3 { class: "text-xl font-bold text-white", "Create Channel" }
                    p { class: "text-sm text-gray-400 mt-1", "in # {group_name}" }
                }
                // Form
                form { onsubmit: handle_submit,
                    div { class: "p-6 space-y-4",
                        div {
                            label { class: "block text-sm font-medium text-gray-300 mb-2",
                                "Channel Name"
                            }
                            div { class: "relative",
                                span { class: "absolute left-4 top-1/2 -translate-y-1/2 text-gray-500",
                                    "#"
                                }
                                input {
                                    class: "w-full bg-[#2b2d31] border border-[#3f4147] rounded-lg pl-8 pr-4 py-3 text-white placeholder-[#6d6f78] focus:outline-none focus:border-indigo-500 transition-colors",
                                    r#type: "text",
                                    placeholder: "new-channel",
                                    value: "{name}",
                                    oninput: move |e: FormEvent| {
                                        name.set(e.value());
                                        error.set(None);
                                    },
                                }
                            }
                        }
                        div {
                            label { class: "block text-sm font-medium text-gray-300 mb-2",
                                "Topic (optional)"
                            }
                            input {
                                class: "w-full bg-[#2b2d31] border border-[#3f4147] rounded-lg px-4 py-3 text-white placeholder-[#6d6f78] focus:outline-none focus:border-indigo-500 transition-colors",
                                r#type: "text",
                                placeholder: "What's this channel about?",
                                value: "{topic}",
                                oninput: move |e: FormEvent| topic.set(e.value()),
                            }
                        }
                        if let Some(err) = error.read().as_ref() {
                            div { class: "p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm",
                                "{err}"
                            }
                        }
                    }
                    // Footer
                    div { class: "px-6 py-4 border-t border-[#3f4147] flex justify-end gap-3",
                        button {
                            r#type: "button",
                            class: "px-4 py-2 text-gray-300 hover:text-white transition-colors",
                            onclick: move |_| on_close.call(()),
                            "Cancel"
                        }
                        button {
                            r#type: "submit",
                            class: "px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                            disabled: *is_loading.read(),
                            if *is_loading.read() {
                                "Creating..."
                            } else {
                                "Create Channel"
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Modal for joining a group
#[component]
pub fn JoinGroupModal(on_close: EventHandler<()>, on_joined: EventHandler<()>) -> Element {
    let auth = use_context::<AuthContext>();
    let mut group_name = use_signal(|| String::new());
    let mut host_url = use_signal(|| String::new());
    let mut error = use_signal(|| None::<String>);
    let mut is_loading = use_signal(|| false);

    let handle_submit = move |e: FormEvent| {
        e.prevent_default();
        let name = group_name.read().trim().to_string();
        let host = host_url.read().trim().to_string();

        if name.is_empty() {
            error.set(Some("Group name is required".to_string()));
            return;
        }

        is_loading.set(true);
        let on_joined = on_joined.clone();
        let auth = auth.clone();

        spawn(async move {
            let token = auth.token();
            let client = ApiClient::new(token.clone());

            // 1. Join the group on the target host (or local if no host specified)
            let target_url = if host.is_empty() {
                auth.api_url(&format!("/api/groups/{name}/join"))
            } else {
                let base = host.trim_end_matches('/');
                let base = if base.starts_with("http") {
                    base.to_string()
                } else {
                    format!("https://{}", base)
                };
                format!("{base}/api/groups/{name}/join")
            };

            match client.post_json::<_, ()>(&target_url, &()).await {
                Ok(_) => {
                    // 2. If successful, add to our local profile if it was a remote join
                    if !host.is_empty() {
                        let local_client = ApiClient::new(token.clone());
                        let local_url = auth.api_url("/api/me/groups");

                        let req = crate::users::AddJoinedGroupRequest {
                            group_id: name.clone(), // Use name as ID
                            name: name.clone(),
                            host: Some(host.clone()),
                        };

                        // We don't block heavily on this, but we should await it to ensure consistency
                        if let Err(e) = local_client
                            .post_json::<_, crate::models::UserJoinedGroup>(&local_url, &req)
                            .await
                        {
                            error.set(Some(format!(
                                "Joined remote group, but failed to save locally: {}",
                                e
                            )));
                            is_loading.set(false);
                            return;
                        }
                    }

                    on_joined.call(());
                }
                Err(err) => {
                    let msg = if let crate::api_client::ApiError::Http { body, .. } = &err {
                        crate::problem::try_problem_detail(body)
                            .unwrap_or_else(|| format!("{}", err))
                    } else {
                        format!("{}", err)
                    };
                    error.set(Some(msg));
                    is_loading.set(false);
                }
            }
        });
    };

    rsx! {
        div { class: "fixed inset-0 bg-black/70 flex items-center justify-center z-50",
            div { class: "bg-[#313338] rounded-lg shadow-2xl w-full max-w-md mx-4",
                // Header
                div { class: "px-6 py-4 border-b border-[#3f4147]",
                    h3 { class: "text-xl font-bold text-white", "Join a Group" }
                    p { class: "text-sm text-gray-400 mt-1", "Join a group by its unique name" }
                }
                // Form
                form { onsubmit: handle_submit,
                    div { class: "p-6 space-y-4",
                        div {
                            label { class: "block text-sm font-medium text-gray-300 mb-2",
                                "Group Name (ID)"
                            }
                            input {
                                class: "w-full bg-[#1e1f22] border-none rounded p-2.5 text-white placeholder-[#949ba4] focus:ring-0",
                                r#type: "text",
                                placeholder: "rust-developers",
                                value: "{group_name}",
                                oninput: move |e: FormEvent| {
                                    group_name.set(e.value());
                                    error.set(None);
                                },
                            }
                        }
                        div {
                            label { class: "block text-sm font-medium text-gray-300 mb-2",
                                "Host (Optional)"
                            }
                            input {
                                class: "w-full bg-[#1e1f22] border-none rounded p-2.5 text-white placeholder-[#949ba4] focus:ring-0",
                                r#type: "text",
                                placeholder: "e.g. matrix.org (leave empty for local)",
                                value: "{host_url}",
                                oninput: move |e: FormEvent| {
                                    host_url.set(e.value());
                                },
                            }
                        }
                        if let Some(err) = error.read().as_ref() {
                            div { class: "p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm",
                                "{err}"
                            }
                        }
                    }
                    // Footer
                    div { class: "px-6 py-4 border-t border-[#3f4147] flex justify-end gap-3",
                        button {
                            r#type: "button",
                            class: "px-4 py-2 text-gray-300 hover:text-white transition-colors",
                            onclick: move |_| on_close.call(()),
                            "Cancel"
                        }
                        button {
                            r#type: "submit",
                            class: "px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                            disabled: *is_loading.read(),
                            if *is_loading.read() {
                                "Joining..."
                            } else {
                                "Join Group"
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Modal for Group Settings
#[component]
pub fn GroupSettingsModal(
    group_id: String,
    group_name: String,
    join_policy: String,
    on_close: EventHandler<()>,
) -> Element {
    let auth = use_context::<AuthContext>();
    let mut current_tab = use_signal(|| "general"); // "general" or "members"
    let mut refresh = use_refresh_resource::<Result<Vec<Group>, ServerFnError>>();

    // General Settings State
    let mut name = use_signal(|| group_name.clone());
    let mut policy = use_signal(|| join_policy.clone());
    let mut is_saving = use_signal(|| false);
    let mut error = use_signal(|| None::<String>);

    let group_id_for_save = group_id.clone();
    let group_id_for_add = group_id.clone();

    // Members Tab State
    let mut add_member_handle = use_signal(|| String::new());
    let mut add_member_error = use_signal(|| None::<String>);
    let mut is_adding_member = use_signal(|| false);

    let handle_save = move |e: FormEvent| {
        e.prevent_default();
        is_saving.set(true);
        let gid = group_id_for_save.clone();
        let new_name = name.read().clone();

        if !crate::models::validate_resource_name(&new_name) {
            error.set(Some("Invalid group name. Must be lowercase alphanumeric, periods, underscores, or dashes.".to_string()));
            is_saving.set(false);
            return;
        }

        let new_policy = policy.read().clone();
        let auth = auth.clone();
        let on_close = on_close.clone();
        let mut refresh = refresh.clone();

        spawn(async move {
            let token = auth.token();
            let client = ApiClient::new(token);
            let url = auth.api_url(&format!("/api/groups/{gid}"));

            match client
                .put_json::<_, ()>(
                    &url,
                    &UpdateGroupSettingsRequest {
                        name: Some(new_name),
                        description: None,
                        join_policy: Some(new_policy),
                    },
                )
                .await
            {
                Ok(_) => {
                    refresh.write();
                    on_close.call(());
                }
                Err(err) => {
                    let msg = if let crate::api_client::ApiError::Http { body, .. } = &err {
                        crate::problem::try_problem_detail(body)
                            .unwrap_or_else(|| format!("{}", err))
                    } else {
                        format!("{}", err)
                    };
                    error.set(Some(msg));
                    is_saving.set(false);
                }
            }
        });
    };

    let handle_add_member = move |e: FormEvent| {
        e.prevent_default();
        let user_handle = add_member_handle.read().trim().to_string();
        if user_handle.is_empty() {
            return;
        }

        is_adding_member.set(true);
        let gid = group_id_for_add.clone();
        let auth = auth.clone();

        spawn(async move {
            let token = auth.token();
            let client = ApiClient::new(token);
            let url = auth.api_url(&format!("/api/groups/{gid}/members"));

            match client
                .post_json::<_, ()>(
                    &url,
                    &AddMemberRequest {
                        handle: user_handle,
                    },
                )
                .await
            {
                Ok(_) => {
                    is_adding_member.set(false);
                    add_member_handle.set(String::new());
                    add_member_error.set(None);
                }
                Err(err) => {
                    let msg = if let crate::api_client::ApiError::Http { body, .. } = &err {
                        crate::problem::try_problem_detail(body)
                            .unwrap_or_else(|| format!("{}", err))
                    } else {
                        format!("{}", err)
                    };
                    add_member_error.set(Some(msg));
                    is_adding_member.set(false);
                }
            }
        });
    };

    rsx! {
        div { class: "fixed inset-0 bg-black/70 flex items-center justify-center z-50",
            div { class: "bg-[#313338] rounded-lg shadow-2xl w-full max-w-2xl h-[600px] flex overflow-hidden",
                // Sidebar
                div { class: "w-48 bg-[#2b2d31] p-3 flex flex-col gap-1",
                    div {
                        class: format!(
                            "px-3 py-2 rounded cursor-pointer text-sm font-medium {}",
                            if *current_tab.read() == "general" {
                                "bg-[#404249] text-white"
                            } else {
                                "text-[#b5bac1] hover:bg-[#35373c] hover:text-[#dbdee1]"
                            },
                        ),
                        onclick: move |_| current_tab.set("general"),
                        "Overview"
                    }
                    div {
                        class: format!(
                            "px-3 py-2 rounded cursor-pointer text-sm font-medium {}",
                            if *current_tab.read() == "members" {
                                "bg-[#404249] text-white"
                            } else {
                                "text-[#b5bac1] hover:bg-[#35373c] hover:text-[#dbdee1]"
                            },
                        ),
                        onclick: move |_| current_tab.set("members"),
                        "Members"
                    }
                    div { class: "flex-1" }
                    div { class: "px-3 py-2 rounded cursor-pointer text-sm font-medium text-red-400 hover:bg-[#35373c]",
                        "Delete Group"
                    }
                }
                // Content
                div { class: "flex-1 flex flex-col bg-[#313338]",
                    // Header
                    div { class: "px-6 py-6",
                        h2 { class: "text-xl font-bold text-white",
                            if *current_tab.read() == "general" {
                                "Overview"
                            } else {
                                "Members"
                            }
                        }
                    }
                    // Body
                    div { class: "flex-1 px-6 overflow-y-auto",
                        if *current_tab.read() == "general" {
                            form { onsubmit: handle_save, class: "space-y-6",
                                div {
                                    label { class: "block text-xs font-bold text-[#b5bac1] uppercase mb-2",
                                        "Group Name"
                                    }
                                    input {
                                        class: "w-full bg-[#1e1f22] border-none rounded p-2.5 text-white focus:ring-0",
                                        value: "{name}",
                                        oninput: move |e: FormEvent| name.set(e.value()),
                                    }
                                }
                                div {
                                    label { class: "block text-xs font-bold text-[#b5bac1] uppercase mb-2",
                                        "Join Policy"
                                    }
                                    div { class: "flex flex-col gap-2",
                                        label { class: "flex items-center gap-3 p-3 rounded bg-[#2b2d31] cursor-pointer hover:bg-[#404249]",
                                            input {
                                                r#type: "radio",
                                                name: "policy",
                                                checked: *policy.read() == "open",
                                                onchange: move |_| policy.set("open".to_string()),
                                                class: "text-indigo-500 focus:ring-indigo-500 bg-[#1e1f22] border-none",
                                            }
                                            div {
                                                div { class: "text-white font-medium",
                                                    "Open"
                                                }
                                                div { class: "text-xs text-[#b5bac1]",
                                                    "Anyone can join this group."
                                                }
                                            }
                                        }
                                        label { class: "flex items-center gap-3 p-3 rounded bg-[#2b2d31] cursor-pointer hover:bg-[#404249]",
                                            input {
                                                r#type: "radio",
                                                name: "policy",
                                                checked: *policy.read() == "whitelist",
                                                onchange: move |_| policy.set("whitelist".to_string()),
                                                class: "text-indigo-500 focus:ring-indigo-500 bg-[#1e1f22] border-none",
                                            }
                                            div {
                                                div { class: "text-white font-medium",
                                                    "Whitelist"
                                                }
                                                div { class: "text-xs text-[#b5bac1]",
                                                    "Join request must be approved."
                                                }
                                            }
                                        }
                                    }
                                }

                                if let Some(err) = error.read().as_ref() {
                                    div { class: "text-red-400 text-sm", "{err}" }
                                }
                                div { class: "flex justify-end pt-4",
                                    button {
                                        r#type: "submit",
                                        class: "px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded transition-colors disabled:opacity-50",
                                        disabled: *is_saving.read(),
                                        if *is_saving.read() {
                                            "Saving..."
                                        } else {
                                            "Save Changes"
                                        }
                                    }
                                }
                            }
                        } else {
                            // Members Tab
                            div { class: "space-y-6",
                                // Add Member
                                div { class: "bg-[#2b2d31] p-4 rounded",
                                    h3 { class: "text-white font-medium mb-2", "Add Member" }
                                    form {
                                        onsubmit: handle_add_member,
                                        class: "flex gap-2",
                                        input {
                                            class: "flex-1 bg-[#1e1f22] border-none rounded p-2 text-white placeholder-[#949ba4] focus:ring-0",
                                            placeholder: "Enter user handle",
                                            value: "{add_member_handle}",
                                            oninput: move |e: FormEvent| {
                                                add_member_handle.set(e.value());
                                                add_member_error.set(None);
                                            },
                                        }
                                        button {
                                            r#type: "submit",
                                            class: "px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded transition-colors disabled:opacity-50",
                                            disabled: *is_adding_member.read(),
                                            if *is_adding_member.read() {
                                                "Adding..."
                                            } else {
                                                "Add"
                                            }
                                        }
                                    }
                                    if let Some(err) = add_member_error.read().as_ref() {
                                        div { class: "mt-2 text-red-400 text-sm", "{err}" }
                                    }
                                }
                                // Member List (Placeholder)
                                div { class: "bg-[#2b2d31] p-4 rounded text-center",
                                    p { class: "text-[#949ba4] text-sm",
                                        "Member management list coming soon."
                                    }
                                }
                            }
                        }
                    }
                    // Footer
                    div { class: "p-4 bg-[#2b2d31] flex justify-end",
                        button {
                            class: "px-4 py-2 bg-[#404249] hover:bg-[#4e5058] text-white rounded font-medium",
                            onclick: move |_| on_close.call(()),
                            "Done"
                        }
                    }
                }
            }
        }
    }
}
