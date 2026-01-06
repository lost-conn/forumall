use crate::Route;
use dioxus::prelude::*;

const NAVBAR_CSS: Asset = asset!("/assets/styling/navbar.css");

/// The Navbar component that will be rendered on all pages of our app since every page is under the layout.
#[component]
pub fn Navbar() -> Element {
    let route: Route = use_route();

    // Hide navbar on Home and ChannelView pages since they have their own sidebar navigation
    let is_chat_view = matches!(
        route,
        Route::Home {}
            | Route::NoGroup {}
            | Route::NoChannel { .. }
            | Route::ChannelView { .. }
    );

    rsx! {
        document::Link { rel: "stylesheet", href: NAVBAR_CSS }

        if !is_chat_view {
            nav {
                id: "navbar",
                Link {
                    to: Route::Home {},
                    class: if matches!(route, Route::Home {}) { "active" } else { "" },
                    svg {
                        class: "w-5 h-5 mr-1",
                        fill: "none",
                        stroke: "currentColor",
                        view_box: "0 0 24 24",
                        path {
                            stroke_linecap: "round",
                            stroke_linejoin: "round",
                            stroke_width: "2",
                            d: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
                        }
                    }
                    "Home"
                }
                Link {
                    to: Route::Login {},
                    class: if matches!(route, Route::Login {}) { "active" } else { "" },
                    "Login"
                }
                Link {
                    to: Route::Register {},
                    class: if matches!(route, Route::Register {}) { "active" } else { "" },
                    "Register"
                }
            }
        }

        Outlet::<Route> {}
    }
}
