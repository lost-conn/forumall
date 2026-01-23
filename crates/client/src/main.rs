//! Forumall Client - Main entry point
//!
//! A Dioxus application for the OFSCP chat protocol.
//! Supports both web (WASM) and desktop platforms.

#![allow(non_snake_case)]

use dioxus::prelude::*;
use forumall_client::{auth_session::AuthProvider, routes::Route, ws::WsManager};

// Assets
const FAVICON: Asset = asset!("/assets/favicon.ico");
const MAIN_CSS: Asset = asset!("/assets/styling/main.css");

fn main() {
    // Initialize tracing for desktop
    #[cfg(not(target_arch = "wasm32"))]
    {
        use tracing_subscriber::EnvFilter;
        tracing_subscriber::fmt()
            .with_env_filter(
                EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| EnvFilter::new("forumall_client=debug")),
            )
            .init();
    }

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
