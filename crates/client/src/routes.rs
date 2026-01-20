//! Application routing configuration.

use dioxus::prelude::*;

use crate::views::{
    ChannelView as ChannelViewComponent, GroupSidebarLayout, Home, HomeSidebarLayout, Login,
    NoChannel, NoGroup, Register,
};

// Router configuration
#[derive(Debug, Clone, Routable, PartialEq)]
#[rustfmt::skip]
pub enum Route {
    // Landing page redirects to login or home
    #[route("/")]
    Home {},

    // Auth routes
    #[route("/login")]
    Login {},
    #[route("/register")]
    Register {},

    // Home with sidebar layout
    #[nest("/home")]
        #[layout(HomeSidebarLayout)]
            #[route("/")]
            NoGroup {},
            #[nest("/:group_host/:group")]
                #[layout(GroupSidebarLayoutWrapper)]
                    #[route("/")]
                    NoChannel { group_host: String, group: String },
                    #[route("/:channel")]
                    ChannelView { group_host: String, group: String, channel: String },
}

/// Wrapper component for GroupSidebarLayout that converts route params to signals
#[component]
pub fn GroupSidebarLayoutWrapper(group_host: String, group: String) -> Element {
    let mut group_host_sig = use_signal(|| group_host.clone());
    let mut group_sig = use_signal(|| group.clone());

    // Update signals when props change
    use_effect(move || {
        group_host_sig.set(group_host.clone());
        group_sig.set(group.clone());
    });

    rsx! {
        GroupSidebarLayout {
            group_host: group_host_sig,
            group: group_sig,
        }
    }
}

/// Wrapper component for ChannelView that converts route params to signals
#[component]
pub fn ChannelView(group_host: String, group: String, channel: String) -> Element {
    let mut group_host_sig = use_signal(|| group_host.clone());
    let mut group_sig = use_signal(|| group.clone());
    let mut channel_sig = use_signal(|| channel.clone());

    // Update signals when props change
    use_effect(move || {
        group_host_sig.set(group_host.clone());
        group_sig.set(group.clone());
        channel_sig.set(channel.clone());
    });

    rsx! {
        ChannelViewComponent {
            group_host: group_host_sig,
            group: group_sig,
            channel: channel_sig,
        }
    }
}
