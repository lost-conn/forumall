//! WebSocket handler for real-time messaging.

use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    http::Uri,
    response::Response,
};
use forumall_shared::{
    BaseMessage, ClientCommand, Content, MessageType, ServerEvent, UserRef, WsEnvelope,
};
use futures_util::{SinkExt, StreamExt};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, RwLock};

use crate::middleware::signature::verify_ofscp_signature_from_query;
use crate::state::AppState;

/// Global channel registry for pub/sub messaging
static CHANNELS: once_cell::sync::Lazy<
    Arc<RwLock<HashMap<String, broadcast::Sender<WsEnvelope<ServerEvent>>>>>,
> = once_cell::sync::Lazy::new(|| Arc::new(RwLock::new(HashMap::new())));

const CHANNEL_CAPACITY: usize = 100;

/// Get or create a broadcast channel for a given channel_id
async fn get_or_create_channel(channel_id: &str) -> broadcast::Sender<WsEnvelope<ServerEvent>> {
    {
        let channels = CHANNELS.read().await;
        if let Some(sender) = channels.get(channel_id) {
            return sender.clone();
        }
    }

    let mut channels = CHANNELS.write().await;
    if let Some(sender) = channels.get(channel_id) {
        return sender.clone();
    }

    let (tx, _rx) = broadcast::channel(CHANNEL_CAPACITY);
    channels.insert(channel_id.to_string(), tx.clone());
    tx
}

/// WebSocket upgrade handler
pub async fn ws_handler(
    State(state): State<AppState>,
    uri: Uri,
    ws: WebSocketUpgrade,
) -> Result<Response, (axum::http::StatusCode, String)> {
    // Verify authentication from query parameters
    let (user_id, _key_id) = verify_ofscp_signature_from_query(&state, &uri)
        .await
        .map_err(|e| {
            tracing::error!("WebSocket auth failed: {}", e);
            (axum::http::StatusCode::UNAUTHORIZED, format!("Unauthorized: {}", e))
        })?;

    tracing::info!("WebSocket connection authenticated for user: {}", user_id);

    Ok(ws.on_upgrade(move |socket| handle_socket(socket, user_id, state)))
}

/// Handle an authenticated WebSocket connection
async fn handle_socket(socket: WebSocket, user_id: String, state: AppState) {
    let (mut sender, mut receiver) = socket.split();

    let mut subscribed_channels: HashSet<String> = HashSet::new();
    let (forward_tx, mut forward_rx) = mpsc::unbounded_channel::<WsEnvelope<ServerEvent>>();
    let mut subscription_handles: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();

    // Task to forward messages to the WebSocket
    let send_task = tokio::spawn(async move {
        while let Some(event) = forward_rx.recv().await {
            let json = serde_json::to_string(&event).unwrap_or_default();
            if sender.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    });

    // Main receive loop
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if let Ok(envelope) = serde_json::from_str::<WsEnvelope<ClientCommand>>(&text) {
                    handle_client_command(
                        &envelope,
                        &user_id,
                        &mut subscribed_channels,
                        &mut subscription_handles,
                        &forward_tx,
                        &state,
                    )
                    .await;
                }
            }
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }

    // Cleanup
    for (_, handle) in subscription_handles {
        handle.abort();
    }
    send_task.abort();

    tracing::info!("WebSocket connection closed for user: {}", user_id);
}

async fn handle_client_command(
    envelope: &WsEnvelope<ClientCommand>,
    user_id: &str,
    subscribed_channels: &mut HashSet<String>,
    subscription_handles: &mut HashMap<String, tokio::task::JoinHandle<()>>,
    forward_tx: &mpsc::UnboundedSender<WsEnvelope<ServerEvent>>,
    state: &AppState,
) {
    match &envelope.payload {
        ClientCommand::Subscribe { channel_id } => {
            tracing::debug!("User {} subscribing to channel {}", user_id, channel_id);

            if subscribed_channels.contains(channel_id) {
                return;
            }

            let broadcast_tx = get_or_create_channel(channel_id).await;
            let mut broadcast_rx = broadcast_tx.subscribe();
            let forward_tx_for_task = forward_tx.clone();
            let cid = channel_id.clone();

            let handle = tokio::spawn(async move {
                while let Ok(event) = broadcast_rx.recv().await {
                    if forward_tx_for_task.send(event).is_err() {
                        break;
                    }
                }
                tracing::debug!("Subscription task for channel {} ended", cid);
            });

            subscription_handles.insert(channel_id.clone(), handle);
            subscribed_channels.insert(channel_id.clone());

            // Send ack
            let ack = WsEnvelope {
                id: uuid::Uuid::new_v4().to_string(),
                payload: ServerEvent::Ack {
                    nonce: envelope.id.clone(),
                    message_id: channel_id.clone(),
                },
                ts: chrono::Utc::now(),
                correlation_id: Some(envelope.id.clone()),
            };
            let _ = forward_tx.send(ack);
        }

        ClientCommand::Unsubscribe { channel_id } => {
            tracing::debug!("User {} unsubscribing from channel {}", user_id, channel_id);

            if let Some(handle) = subscription_handles.remove(channel_id) {
                handle.abort();
            }
            subscribed_channels.remove(channel_id);

            let ack = WsEnvelope {
                id: uuid::Uuid::new_v4().to_string(),
                payload: ServerEvent::Ack {
                    nonce: envelope.id.clone(),
                    message_id: channel_id.clone(),
                },
                ts: chrono::Utc::now(),
                correlation_id: Some(envelope.id.clone()),
            };
            let _ = forward_tx.send(ack);
        }

        ClientCommand::MessageCreate {
            channel_id,
            body,
            nonce,
        } => {
            tracing::debug!("User {} sending message to channel {}", user_id, channel_id);

            let message_id = uuid::Uuid::new_v4().to_string();
            let now = chrono::Utc::now();

            let insert_result = state.db
                .insert_into(
                    "messages",
                    vec![
                        ("id", message_id.clone().into()),
                        ("channel_id", channel_id.clone().into()),
                        ("sender_user_id", user_id.to_string().into()),
                        ("body", body.clone().into()),
                        ("created_at", now.to_rfc3339().into()),
                    ],
                )
                .await;

            match insert_result {
                Ok(_) => {
                    let message = BaseMessage {
                        id: message_id.clone(),
                        author: UserRef::Handle(user_id.to_string()),
                        r#type: MessageType::Message,
                        content: Content {
                            text: body.clone(),
                            mime: "text/plain".to_string(),
                        },
                        attachments: vec![],
                        reference: None,
                        tags: vec![],
                        created_at: now,
                        permissions: None,
                        metadata: vec![],
                    };

                    let event = WsEnvelope {
                        id: uuid::Uuid::new_v4().to_string(),
                        payload: ServerEvent::MessageNew { message },
                        ts: now,
                        correlation_id: Some(envelope.id.clone()),
                    };

                    // Broadcast to all subscribers
                    let tx = get_or_create_channel(channel_id).await;
                    let _ = tx.send(event);

                    // Send ack
                    let ack = WsEnvelope {
                        id: uuid::Uuid::new_v4().to_string(),
                        payload: ServerEvent::Ack {
                            nonce: nonce.clone(),
                            message_id,
                        },
                        ts: now,
                        correlation_id: Some(envelope.id.clone()),
                    };
                    let _ = forward_tx.send(ack);
                }
                Err(e) => {
                    tracing::error!("Failed to save message: {}", e);

                    let error = WsEnvelope {
                        id: uuid::Uuid::new_v4().to_string(),
                        payload: ServerEvent::Error {
                            code: "DB_ERROR".to_string(),
                            message: format!("Failed to save message: {}", e),
                            correlation_id: Some(envelope.id.clone()),
                        },
                        ts: chrono::Utc::now(),
                        correlation_id: Some(envelope.id.clone()),
                    };
                    let _ = forward_tx.send(error);
                }
            }
        }
    }
}
