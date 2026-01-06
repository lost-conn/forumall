use base64::Engine as _;
use dioxus_fullstack::{get, post, HeaderMap, HttpError, Json, StatusCode};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SendMessageRequest {
    pub body: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SendMessageResponse {
    pub item: TimelineItem,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum TimelineItem {
    Message(BaseMessage),
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BaseMessage {
    pub id: String,
    pub author: UserRef,
    #[serde(rename = "type")]
    pub kind: String,
    pub content: Content,
    pub attachments: Vec<serde_json::Value>,
    pub createdAt: String,
    pub metadata: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Content {
    pub text: String,
    pub mime: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UserRef {
    pub id: String,
}

/// OFSCP v0.1: Post a message to a group channel.
#[post("/api/groups/:group_id/channels/:channel_id/messages", headers: HeaderMap)]
pub async fn send_message(
    group_id: String,
    channel_id: String,
    Json(payload): Json<SendMessageRequest>,
) -> Result<Json<SendMessageResponse>, HttpError> {
    let authed = crate::server::auth::require_bearer_user_id(&headers)?;
    let idempotency_key = crate::server::auth::idempotency_key(&headers);
    let message_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    #[cfg(feature = "server")]
    {
        let db = &*crate::DB;

        // Ensure channel belongs to group
        let channel_match = db
            .query("channels")
            .filter(|f| f.eq("id", channel_id.clone()))
            .collect()
            .await
            .map_err(|e| {
                HttpError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Database error: {e}"),
                )
            })?
            .into_iter()
            .next()
            .ok_or_else(|| HttpError::new(StatusCode::NOT_FOUND, "Channel not found"))?;

        let channel_group_id = channel_match
            .data
            .get("group_id")
            .and_then(|v: &aurora_db::Value| v.as_str())
            .unwrap_or("");
        if channel_group_id != group_id {
            return Err(HttpError::new(
                StatusCode::NOT_FOUND,
                "Channel not found in group",
            ));
        }

        // access control: must be a group member
        let gid = group_id.clone();
        let uid = authed.user_id.clone();
        let is_member = db
            .query("group_members")
            .filter(move |f| f.eq("group_id", gid.clone()) & f.eq("user_id", uid.clone()))
            .collect()
            .await
            .map(|docs| !docs.is_empty())
            .map_err(|e| {
                HttpError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Database error: {e}"),
                )
            })?;

        if !is_member {
            return Err(HttpError::new(
                StatusCode::FORBIDDEN,
                "Not a member of that group",
            ));
        }

        // idempotency: duplicates return 409
        if let Some(ref key) = idempotency_key {
            let uid = authed.user_id.clone();
            let k = key.clone();
            let exists = db
                .query("idempotency_keys")
                .filter(move |f| f.eq("user_id", uid.clone()) & f.eq("key", k.clone()))
                .collect()
                .await
                .map(|docs| !docs.is_empty())
                .map_err(|e| {
                    HttpError::new(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Database error: {e}"),
                    )
                })?;

            if exists {
                return Err(HttpError::new(
                    StatusCode::CONFLICT,
                    "Duplicate Idempotency-Key",
                ));
            }
        }

        db.insert_into(
            "messages",
            vec![
                ("id", message_id.clone().into()),
                ("channel_id", channel_id.clone().into()),
                ("sender_user_id", authed.user_id.clone().into()),
                ("body", payload.body.clone().into()),
                ("created_at", now.clone().into()),
            ],
        )
        .await
        .map_err(|e| {
            HttpError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Database error: {e}"),
            )
        })?;

        if let Some(ref key) = idempotency_key {
            db.insert_into(
                "idempotency_keys",
                vec![
                    ("user_id", authed.user_id.clone().into()),
                    ("key", key.clone().into()),
                    ("created_at", now.clone().into()),
                ],
            )
            .await
            .map_err(|e| {
                HttpError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Database error: {e}"),
                )
            })?;
        }

        let item = TimelineItem::Message(BaseMessage {
            id: message_id.clone(),
            author: UserRef {
                id: format!("https://localhost/api/users/{}", authed.user_id),
            },
            kind: "message".to_string(),
            content: Content {
                text: payload.body,
                mime: "text/plain".to_string(),
            },
            attachments: vec![],
            createdAt: now,
            metadata: vec![],
        });

        Ok(Json(SendMessageResponse { item }))
    }
    #[cfg(not(feature = "server"))]
    Err(HttpError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Server feature not enabled",
    ))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PageInfo {
    pub nextCursor: Option<String>,
    pub prevCursor: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MessagesPage {
    pub items: Vec<TimelineItem>,
    pub page: PageInfo,
}

/// OFSCP v0.1: List messages in a group channel.
#[get("/api/groups/:group_id/channels/:channel_id/messages", headers: HeaderMap)]
pub async fn list_messages(
    group_id: String,
    channel_id: String,
    cursor: Option<String>,
    direction: Option<String>,
    limit: Option<u32>,
) -> Result<Json<MessagesPage>, HttpError> {
    let authed = crate::server::auth::require_bearer_user_id(&headers)?;
    let limit = limit.unwrap_or(50).min(200) as usize;
    let direction = direction.unwrap_or_else(|| "backward".to_string());

    if direction != "backward" && direction != "forward" {
        return Err(HttpError::new(
            StatusCode::BAD_REQUEST,
            "Unsupported direction",
        ));
    }

    #[cfg(feature = "server")]
    {
        let db = &*crate::DB;

        // access control: must be a group member
        let gid = group_id.clone();
        let uid = authed.user_id.clone();
        let is_member = db
            .query("group_members")
            .filter(move |f| f.eq("group_id", gid.clone()) & f.eq("user_id", uid.clone()))
            .collect()
            .await
            .map(|docs| !docs.is_empty())
            .map_err(|e| {
                HttpError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Database error: {e}"),
                )
            })?;

        if !is_member {
            return Err(HttpError::new(
                StatusCode::FORBIDDEN,
                "Not a member of that group",
            ));
        }

        // Ensure channel belongs to group
        let channel_match = db
            .query("channels")
            .filter(|f| f.eq("id", channel_id.clone()))
            .collect()
            .await
            .map_err(|e| {
                HttpError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Database error: {e}"),
                )
            })?
            .into_iter()
            .next()
            .ok_or_else(|| HttpError::new(StatusCode::NOT_FOUND, "Channel not found"))?;

        let channel_group_id = channel_match
            .data
            .get("group_id")
            .and_then(|v: &aurora_db::Value| v.as_str())
            .unwrap_or("");
        if channel_group_id != group_id {
            return Err(HttpError::new(
                StatusCode::NOT_FOUND,
                "Channel not found in group",
            ));
        }

        let decode_cursor = |c: &str| -> Option<(String, String)> {
            let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(c)
                .ok()?;
            let s = String::from_utf8(raw).ok()?;
            let (ts, id) = s.split_once('|')?;
            Some((ts.to_string(), id.to_string()))
        };
        let encode_cursor = |ts: &str, id: &str| -> String {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!("{}|{}", ts, id))
        };

        let cursor_decoded = cursor.as_deref().and_then(decode_cursor);

        let messages_all = db
            .query("messages")
            .filter(|f| f.eq("channel_id", channel_id.clone()))
            .collect()
            .await
            .map_err(|e| {
                HttpError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Database error: {e}"),
                )
            })?;

        let mut sorted = messages_all;
        sorted.sort_by(|a, b| {
            let a_ts = a
                .data
                .get("created_at")
                .and_then(|v: &aurora_db::Value| v.as_str())
                .unwrap_or("");
            let b_ts = b
                .data
                .get("created_at")
                .and_then(|v: &aurora_db::Value| v.as_str())
                .unwrap_or("");
            let ts_cmp = a_ts.cmp(b_ts);
            if ts_cmp == std::cmp::Ordering::Equal {
                let a_id = a
                    .data
                    .get("id")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .unwrap_or("");
                let b_id = b
                    .data
                    .get("id")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .unwrap_or("");
                a_id.cmp(b_id)
            } else {
                ts_cmp
            }
        });

        let mut filtered: Vec<aurora_db::Document> = if let Some((ts, mid)) = cursor_decoded {
            if direction == "forward" {
                sorted
                    .into_iter()
                    .filter(|m| {
                        let m_ts = m
                            .data
                            .get("created_at")
                            .and_then(|v: &aurora_db::Value| v.as_str())
                            .unwrap_or("");
                        let m_id = m
                            .data
                            .get("id")
                            .and_then(|v: &aurora_db::Value| v.as_str())
                            .unwrap_or("");
                        m_ts > ts.as_str() || (m_ts == ts.as_str() && m_id > mid.as_str())
                    })
                    .collect()
            } else {
                let mut res: Vec<aurora_db::Document> = sorted
                    .into_iter()
                    .filter(|m| {
                        let m_ts = m
                            .data
                            .get("created_at")
                            .and_then(|v: &aurora_db::Value| v.as_str())
                            .unwrap_or("");
                        let m_id = m
                            .data
                            .get("id")
                            .and_then(|v: &aurora_db::Value| v.as_str())
                            .unwrap_or("");
                        m_ts < ts.as_str() || (m_ts == ts.as_str() && m_id < mid.as_str())
                    })
                    .collect();
                res.reverse();
                res
            }
        } else {
            if direction == "forward" {
                sorted
            } else {
                sorted.reverse();
                sorted
            }
        };

        let page_items: Vec<_> = filtered.drain(..limit.min(filtered.len())).collect();
        let mut items: Vec<TimelineItem> = page_items
            .into_iter()
            .map(|m| {
                let id = m
                    .data
                    .get("id")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let sender_user_id = m
                    .data
                    .get("sender_user_id")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .unwrap_or("");
                let body = m
                    .data
                    .get("body")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let created_at = m
                    .data
                    .get("created_at")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .unwrap_or("")
                    .to_string();

                TimelineItem::Message(BaseMessage {
                    id,
                    author: UserRef {
                        id: format!("https://localhost/api/users/{}", sender_user_id),
                    },
                    kind: "message".to_string(),
                    content: Content {
                        text: body,
                        mime: "text/plain".to_string(),
                    },
                    attachments: vec![],
                    createdAt: created_at,
                    metadata: vec![],
                })
            })
            .collect();

        if direction == "backward" {
            items.reverse();
        }

        let next_cursor = items.first().map(|i| {
            let TimelineItem::Message(m) = i;
            encode_cursor(&m.createdAt, &m.id)
        });
        let prev_cursor = items.last().map(|i| {
            let TimelineItem::Message(m) = i;
            encode_cursor(&m.createdAt, &m.id)
        });

        Ok(Json(MessagesPage {
            items,
            page: PageInfo {
                nextCursor: next_cursor,
                prevCursor: prev_cursor,
            },
        }))
    }
    #[cfg(not(feature = "server"))]
    Err(HttpError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Server feature not enabled",
    ))
}
