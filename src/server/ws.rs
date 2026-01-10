use dioxus::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClientCommand {
    Subscribe { channel_id: String },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ServerEvent {
    Message { channel_id: String, body: String },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WsEnvelope<T> {
    pub payload: T,
}

#[cfg(feature = "server")]
use crate::server::middleware::cors::api_cors_layer;

#[cfg(feature = "server")]
#[dioxus_fullstack::get("/api/ws")]
#[middleware(api_cors_layer())]
pub async fn new_ws() -> Result<(), dioxus_fullstack::HttpError> {
    Err(dioxus_fullstack::HttpError::new(
        dioxus_fullstack::http::StatusCode::NOT_IMPLEMENTED,
        "WebSocket authentication transition in progress",
    ))
}
