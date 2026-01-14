use crate::models::{BaseMessage, ClientCommand, Content, MessageType, ServerEvent, UserRef, WsEnvelope};
use dioxus::prelude::*;

#[cfg(feature = "server")]
use crate::server::middleware::cors::api_cors_layer;

#[cfg(feature = "server")]
use {
    dioxus::logger::tracing,
    dioxus_fullstack::http::Uri,
    dioxus_fullstack::{WebSocketOptions, Websocket},
    std::collections::HashMap,
    std::sync::Arc,
    tokio::sync::{broadcast, RwLock},
};

/// Global channel registry for pub/sub messaging
#[cfg(feature = "server")]
static CHANNELS: once_cell::sync::Lazy<
    Arc<RwLock<HashMap<String, broadcast::Sender<WsEnvelope<ServerEvent>>>>>,
> = once_cell::sync::Lazy::new(|| Arc::new(RwLock::new(HashMap::new())));

#[cfg(feature = "server")]
const CHANNEL_CAPACITY: usize = 100;

/// Get or create a broadcast channel for a given channel_id
#[cfg(feature = "server")]
async fn get_or_create_channel(
    channel_id: &str,
) -> broadcast::Sender<WsEnvelope<ServerEvent>> {
    // Try to get existing channel with read lock
    {
        let channels = CHANNELS.read().await;
        if let Some(sender) = channels.get(channel_id) {
            return sender.clone();
        }
    }

    // Create new channel with write lock
    let mut channels = CHANNELS.write().await;
    // Double-check after acquiring write lock
    if let Some(sender) = channels.get(channel_id) {
        return sender.clone();
    }

    let (tx, _rx) = broadcast::channel(CHANNEL_CAPACITY);
    channels.insert(channel_id.to_string(), tx.clone());
    tx
}

/// WebSocket endpoint with OFSCP signature authentication via query parameters
#[cfg(feature = "server")]
#[dioxus_fullstack::get("/api/ws", uri: Uri)]
#[middleware(api_cors_layer())]
pub async fn ws_handler(
    options: WebSocketOptions,
) -> Result<Websocket<WsEnvelope<ClientCommand>, WsEnvelope<ServerEvent>>, ServerFnError> {
    // Verify authentication from query parameters
    let (user_id, _key_id) = crate::server::signature::verify_ofscp_signature_from_query(&uri)
        .await
        .map_err(|e| {
            tracing::error!("WebSocket auth failed: {}", e);
            ServerFnError::new(format!("Unauthorized: {}", e))
        })?;

    tracing::info!("WebSocket connection authenticated for user: {}", user_id);

    Ok(options.on_upgrade(move |mut socket| async move {
        use std::collections::HashSet;
        use tokio::sync::mpsc;

        let mut subscribed_channels: HashSet<String> = HashSet::new();

        // Channel for receiving broadcast messages to forward to the client
        let (forward_tx, mut forward_rx) = mpsc::unbounded_channel::<WsEnvelope<ServerEvent>>();

        // Spawn tasks to forward from broadcast channels to our mpsc channel
        let mut subscription_handles: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();

        loop {
            tokio::select! {
                // Handle incoming client messages
                msg = socket.recv() => {
                    match msg {
                        Ok(envelope) => {
                            handle_client_command(
                                &envelope,
                                &user_id,
                                &mut subscribed_channels,
                                &mut subscription_handles,
                                &forward_tx,
                                &mut socket,
                            ).await;
                        }
                        Err(e) => {
                            tracing::debug!("WebSocket receive error (client disconnected?): {:?}", e);
                            break;
                        }
                    }
                }

                // Forward messages from subscribed channels to the client
                Some(event) = forward_rx.recv() => {
                    let _ = socket.send(event).await;
                }
            }
        }

        // Clean up subscription tasks
        for (_, handle) in subscription_handles {
            handle.abort();
        }

        tracing::info!("WebSocket connection closed for user: {}", user_id);
    }))
}

#[cfg(feature = "server")]
async fn handle_client_command(
    envelope: &WsEnvelope<ClientCommand>,
    user_id: &str,
    subscribed_channels: &mut std::collections::HashSet<String>,
    subscription_handles: &mut HashMap<String, tokio::task::JoinHandle<()>>,
    forward_tx: &tokio::sync::mpsc::UnboundedSender<WsEnvelope<ServerEvent>>,
    socket: &mut dioxus_fullstack::TypedWebsocket<
        WsEnvelope<ClientCommand>,
        WsEnvelope<ServerEvent>,
    >,
) {
    match &envelope.payload {
        ClientCommand::Subscribe { channel_id } => {
            tracing::debug!("User {} subscribing to channel {}", user_id, channel_id);

            // Don't re-subscribe if already subscribed
            if subscribed_channels.contains(channel_id) {
                return;
            }

            let broadcast_tx = get_or_create_channel(channel_id).await;
            let mut broadcast_rx = broadcast_tx.subscribe();
            let forward_tx = forward_tx.clone();
            let cid = channel_id.clone();

            // Spawn a task to forward messages from the broadcast channel to the mpsc channel
            let handle = tokio::spawn(async move {
                while let Ok(event) = broadcast_rx.recv().await {
                    if forward_tx.send(event).is_err() {
                        break; // Client disconnected
                    }
                }
                tracing::debug!("Subscription task for channel {} ended", cid);
            });

            subscription_handles.insert(channel_id.clone(), handle);
            subscribed_channels.insert(channel_id.clone());

            // Send acknowledgment
            let ack = WsEnvelope {
                id: uuid::Uuid::new_v4().to_string(),
                payload: ServerEvent::Ack {
                    nonce: envelope.id.clone(),
                    message_id: channel_id.clone(),
                },
                ts: chrono::Utc::now(),
                correlation_id: Some(envelope.id.clone()),
            };
            let _ = socket.send(ack).await;
        }

        ClientCommand::Unsubscribe { channel_id } => {
            tracing::debug!("User {} unsubscribing from channel {}", user_id, channel_id);

            // Abort the subscription task
            if let Some(handle) = subscription_handles.remove(channel_id) {
                handle.abort();
            }
            subscribed_channels.remove(channel_id);

            // Send acknowledgment
            let ack = WsEnvelope {
                id: uuid::Uuid::new_v4().to_string(),
                payload: ServerEvent::Ack {
                    nonce: envelope.id.clone(),
                    message_id: channel_id.clone(),
                },
                ts: chrono::Utc::now(),
                correlation_id: Some(envelope.id.clone()),
            };
            let _ = socket.send(ack).await;
        }

        ClientCommand::MessageCreate {
            channel_id,
            body,
            nonce,
        } => {
            tracing::debug!(
                "User {} sending message to channel {}: {}",
                user_id,
                channel_id,
                body
            );

            // Save message to database
            let db = &*crate::DB;
            let message_id = uuid::Uuid::new_v4().to_string();
            let now = chrono::Utc::now();

            let insert_result = db
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
                    // Create message for broadcast
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

                    // Broadcast to all subscribers of this channel
                    let tx = get_or_create_channel(channel_id).await;
                    let _ = tx.send(event);

                    // Send ACK to the sender
                    let ack = WsEnvelope {
                        id: uuid::Uuid::new_v4().to_string(),
                        payload: ServerEvent::Ack {
                            nonce: nonce.clone(),
                            message_id,
                        },
                        ts: now,
                        correlation_id: Some(envelope.id.clone()),
                    };
                    let _ = socket.send(ack).await;
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
                    let _ = socket.send(error).await;
                }
            }
        }
    }
}

// Client-side stub (required for fullstack compilation)
#[cfg(not(feature = "server"))]
pub async fn ws_handler() -> Result<(), ServerFnError> {
    Err(ServerFnError::new("Server feature not enabled"))
}
