//! Forumall Server - OFSCP Provider
//!
//! A pure Axum server implementing the OFSCP (Open Federated Social Communications Protocol).

use axum::{
    routing::{delete, get, post, put},
    Router,
};
use std::net::SocketAddr;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod db;
mod middleware;
mod routes;
mod state;
mod ws;

use state::AppState;

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "forumall_server=debug,tower_http=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Initialize database
    let db = db::init_database();
    let state = AppState::new(db);

    // Build CORS layer
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Build router
    let app = Router::new()
        // Discovery
        .route("/.well-known/ofscp-provider", get(routes::discovery::ofscp_provider))
        .route("/.well-known/ofscp/users/{handle}/keys", get(routes::device_keys::get_public_keys))
        // Auth
        .route("/api/auth/register", post(routes::auth::register))
        .route("/api/auth/login", post(routes::auth::login))
        .route("/api/auth/device-keys", post(routes::device_keys::register_device_key))
        .route("/api/auth/device-keys", get(routes::device_keys::list_device_keys))
        .route("/api/auth/device-keys/{key_id}", delete(routes::device_keys::revoke_device_key))
        // Groups
        .route("/api/groups", post(routes::groups::create_group))
        .route("/api/groups", get(routes::groups::list_groups))
        .route("/api/groups/{group_id}", get(routes::groups::get_group))
        .route("/api/groups/{group_id}", put(routes::groups::update_group))
        .route("/api/groups/{group_id}/join", post(routes::groups::join_group))
        .route("/api/groups/{group_id}/members", post(routes::groups::add_member))
        // Channels
        .route("/api/groups/{group_id}/channels", get(routes::channels::list_channels))
        .route("/api/groups/{group_id}/channels", post(routes::channels::create_channel))
        // Messages
        .route("/api/groups/{group_id}/channels/{channel_id}/messages", get(routes::messages::list_messages))
        .route("/api/groups/{group_id}/channels/{channel_id}/messages", post(routes::messages::send_message))
        // Users
        .route("/api/users/{handle}/profile", get(routes::users::get_user_profile))
        .route("/api/users/{user_id}/groups", get(routes::users::get_user_groups))
        .route("/api/users/{user_id}/groups", post(routes::users::add_user_joined_group))
        .route("/api/me/groups", post(routes::users::add_self_joined_group))
        // WebSocket
        .route("/api/ws", get(ws::ws_handler))
        // Apply middleware
        .layer(cors)
        .with_state(state);

    // Start server
    let addr = SocketAddr::from(([0, 0, 0, 0], 8080));
    tracing::info!("Starting server on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
