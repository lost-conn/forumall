#![allow(non_snake_case)]

use dioxus::prelude::*;
use dioxus_fullstack::{Json, WebsocketState};
use views::{
    ChannelView, GroupSidebarLayout, Home, HomeSidebarLayout, Login, Navbar, NoChannel, NoGroup,
    Register,
};

use crate::models::*;

mod api_client;
mod auth;
mod auth_session;
mod components;
mod device_keys;
mod groups;
mod hooks;
mod messages;
mod models;
mod problem;
mod server;
mod users;
mod views;
mod ws_client;

#[derive(Debug, Clone, Routable, PartialEq)]
#[rustfmt::skip]
enum Route {
    #[route("/")]
    Home {},
    #[layout(Navbar)]
        #[route("/login")]
        Login {},
        #[route("/register")]
        Register {},
        #[route("/test-ws")]
        WebSocketTest {},
    #[end_layout]
    #[nest("/home")]
        #[layout(HomeSidebarLayout)]
            #[route("/")]
            NoGroup {},
            #[nest("/:group")]
                #[layout(GroupSidebarLayout)]
                    #[route("/")]
                    NoChannel { group: String },
                    #[route("/:channel")]
                    ChannelView { group: String, channel: String },
}
const FAVICON: Asset = asset!("/assets/favicon.ico");
const MAIN_CSS: Asset = asset!("/assets/styling/main.css");

#[cfg(feature = "server")]
pub static DB: once_cell::sync::Lazy<aurora_db::Aurora> = once_cell::sync::Lazy::new(|| {
    let db_path = std::env::var("FORUMALL_DB_PATH").unwrap_or_else(|_| "aurora_db_data".to_string());
    let db = aurora_db::Aurora::open(&db_path).expect("Failed to open database");

    // Initialize collections
    use aurora_db::FieldType;
    let _ = db.new_collection(
        "users",
        vec![
            ("handle", FieldType::String, true),
            ("domain", FieldType::String, false),
            ("password_hash", FieldType::String, false),
            ("created_at", FieldType::String, false),
            ("updated_at", FieldType::String, false),
        ],
    );
    let _ = db.new_collection(
        "groups",
        vec![
            ("id", FieldType::String, true),
            ("name", FieldType::String, false),
            ("description", FieldType::String, false),
            ("join_policy", FieldType::String, false),
            ("owner_user_id", FieldType::String, false),
            ("created_at", FieldType::String, false),
        ],
    );
    let _ = db.new_collection(
        "group_members",
        vec![
            ("group_id", FieldType::String, false),
            ("user_id", FieldType::String, false),
            ("role", FieldType::String, false),
            ("created_at", FieldType::String, false),
        ],
    );
    let _ = db.new_collection(
        "channels",
        vec![
            ("id", FieldType::String, true),
            ("group_id", FieldType::String, false),
            ("name", FieldType::String, false),
            ("topic", FieldType::String, false),
            ("created_at", FieldType::String, false),
            ("updated_at", FieldType::String, false),
        ],
    );
    let _ = db.new_collection(
        "messages",
        vec![
            ("id", FieldType::String, true),
            ("channel_id", FieldType::String, false),
            ("sender_user_id", FieldType::String, false),
            ("body", FieldType::String, false),
            ("created_at", FieldType::String, false),
        ],
    );
    let _ = db.new_collection(
        "idempotency_keys",
        vec![
            ("user_id", FieldType::String, false),
            ("key", FieldType::String, false),
            ("created_at", FieldType::String, false),
        ],
    );
    let _ = db.new_collection(
        "user_joined_groups",
        vec![
            ("user_id", FieldType::String, false),
            ("group_id", FieldType::String, false),
            ("host", FieldType::String, false), // e.g. "https://remote-instance.com", or empty for local
            ("name", FieldType::String, false),
            ("joined_at", FieldType::String, false),
        ],
    );
    let _ = db.new_collection(
        "device_keys",
        vec![
            ("key_id", FieldType::String, true),
            ("user_handle", FieldType::String, false),
            ("public_key", FieldType::String, false), // Base64 encoded
            ("device_name", FieldType::String, false),
            ("created_at", FieldType::String, false),
            ("last_used_at", FieldType::String, false),
            ("revoked", FieldType::String, false), // "true" or "false"
        ],
    );

    db
});

fn main() {
    dioxus::launch(App);
}

#[component]
fn WebSocketTest() -> Element {
    use crate::auth_session::AuthContext;
    use crate::models::{ClientCommand, WsEnvelope};
    use crate::ws_client::use_ws;
    use uuid;

    let auth = use_context::<AuthContext>();

    if !auth.is_authenticated() {
        return rsx! {
            div { class: "flex items-center justify-center min-h-screen bg-slate-900 text-white p-8",
                div { class: "bg-red-900/20 p-8 rounded-xl border border-red-500/50 text-center",
                    h2 { class: "text-2xl font-bold mb-4", "Authentication Required" }
                    p { class: "text-gray-400 mb-6",
                        "You need to be logged in to test the WebSocket connection."
                    }
                    Link {
                        to: Route::Login {},
                        class: "px-6 py-2 bg-red-600 hover:bg-red-500 rounded-lg font-semibold transition-colors",
                        "Go to Login"
                    }
                }
            }
        };
    }

    let Some(ws_ctx) = use_ws() else {
        return rsx! {
            div { class: "flex items-center justify-center min-h-screen bg-slate-900 text-white p-8",
                "WebSocket not available"
            }
        };
    };
    let ws = ws_ctx.ws;

    rsx! {
        div { class: "flex flex-col items-center justify-center min-h-screen bg-slate-900 text-white p-8",
            h1 { class: "text-4xl font-bold mb-8 text-blue-400", "Global WebSocket Connection" }
            div { class: "bg-slate-800 p-6 rounded-xl shadow-2xl border border-blue-500/30 w-full max-w-md",
                div { class: "flex items-center space-x-4 mb-6",
                    div {
                        class: "w-3 h-3 rounded-full animate-pulse",
                        background_color: match ws.status()() {
                            WebsocketState::Connecting => "yellow",
                            WebsocketState::Open => "green",
                            _ => "red",
                        },
                    }
                    span { class: "text-lg font-medium", "{ws.status()():?}" }
                }
                button {
                    class: "w-full py-3 px-6 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded-lg font-semibold transition-all duration-200 transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed",
                    disabled: ws.status()() != WebsocketState::Open,
                    onclick: move |_| {
                        async move {
                            let msg = WsEnvelope {
                                id: uuid::Uuid::new_v4().to_string(),
                                ts: chrono::Utc::now(),
                                payload: ClientCommand::MessageCreate {
                                    channel_id: "general".to_string(),
                                    body: "Hello from global OFSCP client!".to_string(),
                                    nonce: "test".to_string(),
                                },
                                correlation_id: None,
                            };
                            _ = ws.send(msg).await;
                        }
                    },
                    "Send Message"
                }
            }
        }
    }
}

#[component]
fn App() -> Element {
    rsx! {
        document::Link { rel: "icon", href: FAVICON }
        document::Link { rel: "stylesheet", href: MAIN_CSS }
        script { src: "https://cdn.tailwindcss.com" }

        auth_session::AuthProvider {
            ws_client::WsProvider { Router::<Route> {} }
        }
    }
}

#[get("/.well-known/ofscp-provider")]
async fn ofscp_provider() -> Result<Json<DiscoveryDocument>> {
    let base_url = dioxus_fullstack::get_server_url();
    let base_url = base_url.trim_end_matches('/');
    let domain = base_url
        .strip_prefix("http://")
        .or_else(|| base_url.strip_prefix("https://"))
        .unwrap_or(&base_url);

    Ok(Json(DiscoveryDocument {
        provider: ProviderInfo {
            domain: domain.to_string(),
            protocol_version: "0.1.0".to_string(),
            software: SoftwareInfo {
                name: "OFSCP Dioxus Provider".to_string(),
                version: "0.1.0".to_string(),
            },
            contact: "admin@localhost".to_string(),
            authentication: AuthenticationEndpoints {
                issuer: format!("{}/api/auth", base_url),
                authorization_endpoint: format!("{}/api/auth/authorize", base_url),
                token_endpoint: format!("{}/api/auth/token", base_url),
                userinfo_endpoint: format!("{}/api/auth/userinfo", base_url),
                jwks_uri: Some(format!("{}/.well-known/jwks.json", base_url)),
            },
            public_keys: None,
        },
        capabilities: Capabilities {
            message_types: vec![
                MessageType::Message,
                MessageType::Memo,
                MessageType::Article,
            ],
            discoverability: vec![Discoverability::Public],
            metadata_schemas: vec![],
        },
        endpoints: Endpoints {
            identity: format!("{}/api/identity", base_url),
            groups: format!("{}/api/groups", base_url),
            notifications: format!("{}/api/notifications", base_url),
            tiers: format!("{}/api/tiers", base_url),
        },
    }))
}
