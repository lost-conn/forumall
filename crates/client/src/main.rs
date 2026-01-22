//! Forumall Client - Main entry point
//!
//! A Dioxus web application for the OFSCP chat protocol.

#![allow(non_snake_case)]

use dioxus::prelude::*;
use forumall_client::{auth_session::AuthProvider, routes::Route, ws::WsManager};

// Assets
const FAVICON: Asset = asset!("/assets/favicon.ico");
const MAIN_CSS: Asset = asset!("/assets/styling/main.css");

fn main() {
    dioxus::launch(App);
}

#[component]
fn App() -> Element {
    rsx! {
        document::Link { rel: "icon", href: FAVICON }
        document::Link { rel: "stylesheet", href: MAIN_CSS }

        AuthProvider {
            WsManager {
                Router::<Route> {}
            }
        }
    }
}
