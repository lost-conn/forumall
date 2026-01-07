use crate::api_client::ApiClient;
use crate::auth_session::AuthContext;
use crate::groups::*;
use crate::views::{ChannelList, CreateChannelModal};
use dioxus::prelude::*;
use dioxus_fullstack::Json;

/// Channel layout component that contains the channel selection sidebar
/// This is the middle layout between SidebarLayout and ChannelView
#[component]
pub fn ChannelLayout(group: ReadSignal<String>) -> Element {
    let auth = use_context::<AuthContext>();
    let mut show_create_channel_modal = use_signal(|| false);

    // Get the current route to extract channel name
    let nav = use_navigator();
    let route = use_route::<crate::Route>();

    // Extract channel name from the current route
    let current_channel_name = match &route {
        crate::Route::ChannelView { channel, .. } => Some(channel.clone()),
        _ => None,
    };

    // Fetch groups data
    let groups = use_resource(move || {
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
                .map(Json)
                .map_err(|e| ServerFnError::new(format!("API error: {e:?}")))
        }
    });

    // Derive selected_group from resource data using use_memo
    // This eliminates the need for use_effect and keeps reactivity automatic
    let selected_group = use_memo(move || {
        if let Some(Ok(groups_data)) = groups.read().as_ref() {
            groups_data
                .0
                .iter()
                .find(|g| g.name == *group.read())
                .cloned()
        } else {
            None
        }
    });

    rsx! {
        // Channel Sidebar
        div { class: "w-60 bg-[#2b2d31] flex flex-col",
            // Group header with gradient
            div { class: "h-12 px-4 flex items-center shadow-md font-semibold text-white border-b border-[#1f2023]",
                if let Some(group) = selected_group.read().as_ref() {
                    "{group.name}"
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
    }
}
