use crate::models::{ClientCommand, ServerEvent, WsEnvelope};
#[cfg(feature = "server")]
use tokio::sync::{broadcast, mpsc, RwLock};
#[cfg(feature = "server")]
use std::collections::HashMap;
#[cfg(feature = "server")]
use std::sync::Arc;
#[cfg(feature = "server")]
use once_cell::sync::Lazy;

#[cfg(feature = "server")]
type ChannelMap = Arc<RwLock<HashMap<String, broadcast::Sender<WsEnvelope<ServerEvent>>>>>;
#[cfg(feature = "server")]
static CHANNELS: Lazy<ChannelMap> = Lazy::new(|| Arc::new(RwLock::new(HashMap::new())));

#[cfg(feature = "server")]
use dioxus_fullstack::TypedWebsocket;
#[cfg(feature = "server")]
use crate::server::middleware::cors::api_cors_layer;
use dioxus_fullstack::{get, HeaderMap, HttpError, WebSocketOptions, Websocket};
use dioxus_fullstack::http::Uri;

#[get("/api/ws", headers: HeaderMap, uri: Uri)]
#[middleware(api_cors_layer())]
async fn new_ws(
    options: WebSocketOptions,
) -> Result<Websocket<WsEnvelope<ClientCommand>, WsEnvelope<ServerEvent>>, HttpError> {
    let token = headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.trim())
        .or_else(|| {
            uri.query().unwrap_or("").split('&').find_map(|s| {
                if let Some(rest) = s.strip_prefix("access_token=") {
                    Some(rest)
                } else {
                    None
                }
            })
        });

    let authed = if let Some(t) = token {
        crate::server::auth::validate_token(t)?
    } else {
        crate::server::auth::require_bearer_user_id(&headers)?
    };

    Ok(
        options.on_upgrade(
            move |mut socket: TypedWebsocket<
                WsEnvelope<ClientCommand>,
                WsEnvelope<ServerEvent>,
            >| async move {
                use dioxus::logger::tracing;
                
                let (tx, mut rx) = mpsc::unbounded_channel();
                let mut subs: std::collections::HashMap<String, tokio::task::JoinHandle<()>> = std::collections::HashMap::new();

                tracing::info!("New WebSocket connection for user: {}", authed.user_id);

                loop {
                    tokio::select! {
                        Some(msg) = rx.recv() => {
                            if let Err(_) = socket.send(msg).await { break; }
                        }
                        res = socket.recv() => {
                            match res {
                                Ok(envelope) => {
                                    tracing::info!("Received command: {:?}", envelope.payload);
                                    match envelope.payload {
                                        ClientCommand::Subscribe { channel_id } => {
                                            tracing::info!("Subscribing to channel: {}", channel_id);
                                            if let Some(h) = subs.remove(&channel_id) { h.abort(); }
                                            
                                            let mut map = CHANNELS.write().await;
                                            let sender = map.entry(channel_id.clone()).or_insert_with(|| {
                                                let (s, _) = broadcast::channel(100);
                                                s
                                            });
                                            let mut b_rx = sender.subscribe();
                                            let my_tx = tx.clone();
                                            let handle = tokio::spawn(async move {
                                                while let Ok(msg) = b_rx.recv().await {
                                                    if my_tx.send(msg).is_err() { break; }
                                                }
                                            });
                                            subs.insert(channel_id, handle);
                                        }
                                        ClientCommand::Unsubscribe { channel_id } => {
                                             tracing::info!("Unsubscribing from channel: {}", channel_id);
                                             if let Some(h) = subs.remove(&channel_id) { h.abort(); }
                                        }
                                        ClientCommand::MessageCreate { channel_id, body, nonce } => {
                                            let message_id = uuid::Uuid::new_v4().to_string();
                                            let created_at = chrono::Utc::now();
                                            let now_str = created_at.to_rfc3339();

                                            // Save to database
                                            let db = &*crate::DB;
                                            let _ = db.insert_into(
                                                "messages",
                                                vec![
                                                    ("id", message_id.clone().into()),
                                                    ("channel_id", channel_id.clone().into()),
                                                    ("sender_user_id", authed.user_id.clone().into()),
                                                    ("body", body.clone().into()),
                                                    ("created_at", now_str.into()),
                                                ],
                                            ).await;

                                            // Broadcast
                                            let map = CHANNELS.read().await;
                                            if let Some(sender) = map.get(&channel_id) {
                                                let msg = crate::models::BaseMessage {
                                                    id: message_id.clone(),
                                                    author: crate::models::UserRef::Handle(authed.user_id.clone()),
                                                    r#type: crate::models::MessageType::Message,
                                                    content: crate::models::Content {
                                                        text: body,
                                                        mime: "text/plain".to_string(),
                                                    },
                                                    attachments: vec![],
                                                    reference: None,
                                                    tags: vec![],
                                                    created_at: created_at,
                                                    permissions: None,
                                                    metadata: vec![],
                                                };
                                                let env = WsEnvelope {
                                                    id: uuid::Uuid::new_v4().to_string(),
                                                    payload: ServerEvent::MessageNew { message: msg },
                                                    ts: chrono::Utc::now(),
                                                    correlation_id: None,
                                                };
                                                let _ = sender.send(env);
                                            }

                                            // Ack
                                            let ack = WsEnvelope {
                                                id: uuid::Uuid::new_v4().to_string(),
                                                payload: ServerEvent::Ack {
                                                    nonce,
                                                    message_id: message_id.clone(),
                                                },
                                                ts: chrono::Utc::now(),
                                                correlation_id: Some(envelope.id),
                                            };
                                            let _ = tx.send(ack);
                                        }
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                    }
                }
                for h in subs.values() { h.abort(); }
                tracing::info!("WebSocket connection closed for user: {}", authed.user_id);
            },
        ),
    )
}
