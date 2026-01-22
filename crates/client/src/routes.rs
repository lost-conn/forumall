//! Application routing configuration.

use dioxus::prelude::*;

use crate::views::{
    ChannelView, GroupSidebarLayout, Home, HomeSidebarLayout, Login,
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
                #[layout(GroupSidebarLayout)]
                    #[route("/")]
                    NoChannel { group_host: String, group: String },
                    #[route("/:channel")]
                    ChannelView { group_host: String, group: String, channel: String },
}