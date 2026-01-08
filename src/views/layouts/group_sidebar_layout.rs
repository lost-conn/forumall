use crate::api_client::ApiClient;
use crate::auth_session::AuthContext;
use crate::groups::*;
use crate::hooks::use_refreshable_resource;
use crate::views::{ChannelList, CreateChannelModal};
use dioxus::prelude::*;
use dioxus_fullstack::Json;

/// Channel layout component that contains the channel selection sidebar
/// This is the middle layout between SidebarLayout and ChannelView
#[component]
pub fn GroupSidebarLayout(group: ReadSignal<String>) -> Element {
    let auth = use_context::<AuthContext>();
    let mut show_create_channel_modal = use_signal(|| false);
    let mut show_settings = use_signal(|| false);

    // Get the current route to extract channel name
    let nav = use_navigator();
    let route = use_route::<crate::Route>();

    // Extract channel name from the current route
    let current_channel_name = match &route {
        crate::Route::ChannelView { channel, .. } => Some(channel.clone()),
        _ => None,
    };

    // Fetch groups data
    let groups = use_refreshable_resource(move || {
        let auth = auth;
        async move {
            let token = auth.token();
            if token.is_none() {
                return Err(ServerFnError::new("Not authenticated"));
            }
            let client = ApiClient::new(token);
            let url = auth.api_url("/api/groups");
            client
                .get_json::<Vec<Group>>(&url)
                .await
                .map_err(|e| ServerFnError::new(format!("API error: {e:?}")))
        }
    });

    // Derive selected_group from resource data using use_memo
    // This eliminates the need for use_effect and keeps reactivity automatic
    let selected_group = use_memo(move || {
        if let Some(Ok(groups_data)) = groups.read().as_ref() {
            groups_data
                .iter()
                .find(|g| g.name == *group.read())
                .cloned()
        } else {
            None
        }
    });

    // Determine if we're currently viewing a specific channel (for responsive hiding)
    let is_channel_selected = matches!(&route, crate::Route::ChannelView { .. });

    // Build sidebar classes: hide on mobile only when a channel is selected
    let sidebar_classes = if is_channel_selected {
        "hidden md:flex w-60 bg-[#2b2d31] flex-col"
    } else {
        "flex w-60 bg-[#2b2d31] flex-col"
    };

    rsx! {
        // Channel Sidebar - hidden on mobile only when viewing a channel
        div { class: "{sidebar_classes}",
            // Group header with gradient
            div { class: "h-12 px-4 flex items-center justify-between shadow-md font-semibold text-white border-b border-[#1f2023]",
                if let Some(group) = selected_group.read().as_ref() {
                    div { class: "flex items-center justify-between w-full min-w-0",
                        div { class: "truncate mr-2", "{group.name}" }
                        button {
                            class: "text-gray-400 hover:text-white transition-colors flex-shrink-0",
                            onclick: move |_| show_settings.set(true),
                            svg {
                                class: "w-4 h-4",
                                fill: "none",
                                stroke: "currentColor",
                                view_box: "0 0 24 24",
                                path {
                                    stroke_linecap: "round",
                                    stroke_linejoin: "round",
                                    stroke_width: "2",
                                    d: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z",
                                }
                                path {
                                    stroke_linecap: "round",
                                    stroke_linejoin: "round",
                                    stroke_width: "2",
                                    d: "M15 12a3 3 0 11-6 0 3 3 0 016 0z",
                                }
                            }
                        }
                    }
                } else {
                    span { class: "text-gray-400", "Select a Group" }
                }
            }
            // Channels list
            div { class: "flex-1 overflow-y-auto pt-4 px-2",
                if let Some(group) = selected_group.read().as_ref() {
                    // Category header
                    div { class: "flex items-center px-1 mb-1 text-xs font-semibold text-gray-400 uppercase tracking-wide",
                        svg {
                            class: "w-3 h-3 mr-1",
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
                        "Text Channels"
                    }
                    {
                        let group_id = group.id.clone();
                        let group_name = group.name.clone();
                        let gn = group_name.clone();
                        let cn = current_channel_name.clone();
                        rsx! {
                            ChannelList {
                                group_id,
                                group_name,
                                selected_channel_name: cn,
                                on_select: move |channel: crate::groups::Channel| {
                                    nav.push(crate::Route::ChannelView {
                                        group: gn.clone(),
                                        channel: channel.name.clone(),
                                    });
                                },
                                on_add_channel: move |_| show_create_channel_modal.set(true),
                            }
                        }
                    }
                }
            }
        }

        // Outlet for child routes (ChannelView)
        Outlet::<crate::Route> {}

        // Create Channel Modal
        if *show_create_channel_modal.read() {
            CreateChannelModal {
                group_id: selected_group.read().as_ref().map(|g| g.id.clone()).unwrap_or_default(),
                group_name: selected_group.read().as_ref().map(|g| g.name.clone()).unwrap_or_default(),
                on_close: move |_| show_create_channel_modal.set(false),
                on_created: move |_| {
                    show_create_channel_modal.set(false);
                },
            }
        }

        // Group Settings Modal
        if *show_settings.read() {
            if let Some(group_data) = selected_group.read().as_ref() {
                crate::views::home::GroupSettingsModal {
                    group_id: group_data.id.clone(),
                    group_name: group_data.name.clone(),
                    join_policy: group_data.join_policy.clone(),
                    on_close: move |_| show_settings.set(false),
                }
            }
        }


    }
}
