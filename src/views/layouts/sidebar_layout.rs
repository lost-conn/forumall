use crate::api_client::ApiClient;
use crate::auth_session::AuthContext;
use crate::groups::*;
use crate::views::CreateGroupModal;
use dioxus::prelude::*;
use dioxus_fullstack::Json;

/// Sidebar layout component that contains the group selection and logout button
/// This is the outermost layout for the home page
#[component]
pub fn SidebarLayout() -> Element {
    let mut auth = use_context::<AuthContext>();
    let mut selected_group = use_signal(|| None::<Group>);
    let mut show_create_group_modal = use_signal(|| false);

    // Redirect to login if not authenticated
    let nav = use_navigator();
    use_effect(move || {
        if !auth.is_authenticated() {
            nav.push(crate::Route::Login {});
        }
    });

    let mut groups = use_resource(move || {
        let auth = auth.clone();
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

    rsx! {
        div { class: "flex h-screen overflow-hidden",
            // Sidebar for Groups - Discord-style with gradient icons
            div { class: "w-[72px] bg-[#1e1f22] flex flex-col items-center py-3 gap-2 overflow-y-auto",
                // Logout button
                button {
                    class: "group relative w-12 h-12 bg-[#313338] rounded-[24px] flex items-center justify-center text-red-400 font-bold cursor-pointer hover:rounded-[16px] hover:bg-red-500 hover:text-white transition-all duration-200",
                    onclick: move |_| {
                        auth.logout();
                        // let nav = use_navigator();
                        // nav.push(crate::Route::Login {});
                    },
                    div { class: "absolute left-full ml-4 px-3 py-2 bg-[#111214] text-white text-sm font-medium rounded-md whitespace-nowrap opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 z-50 shadow-lg",
                        "Log out"
                    }
                    svg {
                        class: "w-5 h-5",
                        fill: "none",
                        stroke: "currentColor",
                        view_box: "0 0 24 24",
                        path {
                            stroke_linecap: "round",
                            stroke_linejoin: "round",
                            stroke_width: "2",
                            d: "M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1",
                        }
                    }
                }

                // Groups list
                if let Some(Ok(groups)) = groups.read().as_ref() {
                    for group in groups.0.iter() {
                        div {
                            key: "{group.id}",
                            class: format!(
                                "group relative w-12 h-12 rounded-[24px] flex items-center justify-center text-white font-semibold cursor-pointer transition-all duration-200 hover:rounded-[16px] {}",
                                if selected_group.read().as_ref().map(|g| &g.id) == Some(&group.id) {
                                    "bg-gradient-to-br from-indigo-500 to-purple-600 rounded-[16px]"
                                } else {
                                    "bg-[#313338] hover:bg-gradient-to-br hover:from-indigo-500 hover:to-purple-600"
                                },
                            ),
                            onclick: {
                                let group = group.clone();
                                move |_| {
                                    selected_group.set(Some(group.clone()));
                                    // Navigate to the group's default view
                                    nav.push(crate::Route::NoChannel {
                                        group: group.name.clone(),
                                    });
                                }
                            },
                            // Tooltip
                            div { class: "absolute left-full ml-4 px-3 py-2 bg-[#111214] text-white text-sm font-medium rounded-md whitespace-nowrap opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 z-50 shadow-lg",
                                "{group.name}"
                            }
                            // Active indicator pill
                            if selected_group.read().as_ref().map(|g| &g.id) == Some(&group.id) {
                                div { class: "absolute left-0 w-1 h-10 bg-white rounded-r-full -ml-[10px]" }
                            }
                            "{group.name.chars().next().unwrap_or('?')}"
                        }
                    }
                }

                // Separator
                div { class: "w-8 h-[2px] bg-[#35363c] rounded-full my-1" }

                // Add group button
                div {
                    class: "group relative w-12 h-12 bg-[#313338] rounded-[24px] flex items-center justify-center text-emerald-400 font-bold cursor-pointer hover:rounded-[16px] hover:bg-emerald-500 hover:text-white transition-all duration-200",
                    onclick: move |_| show_create_group_modal.set(true),
                    div { class: "absolute left-full ml-4 px-3 py-2 bg-[#111214] text-white text-sm font-medium rounded-md whitespace-nowrap opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 z-50 shadow-lg",
                        "Add a Group"
                    }
                    svg {
                        class: "w-5 h-5",
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
            }

            // Outlet for child routes (ChannelLayout)
            Outlet::<crate::Route> {}

            // Create Group Modal
            if *show_create_group_modal.read() {
                CreateGroupModal {
                    on_close: move |_| show_create_group_modal.set(false),
                    on_created: move |_| {
                        show_create_group_modal.set(false);
                        // Refresh the groups list
                        let _ = groups.restart();
                    },
                }
            }
        }
    }
}
