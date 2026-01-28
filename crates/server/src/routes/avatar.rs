//! Avatar upload route.

use axum::{
    extract::{Multipart, State},
    http::StatusCode,
    Json,
};
use forumall_shared::AvatarResponse;
use std::path::PathBuf;

use crate::middleware::signature::SignedRequest;
use crate::state::AppState;

/// Maximum avatar file size (2 MB)
const MAX_AVATAR_SIZE: usize = 2 * 1024 * 1024;

/// Allowed MIME types for avatars
const ALLOWED_MIME_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Upload avatar endpoint (POST /api/me/avatar)
///
/// Note: Because we need both multipart AND signature verification, we check
/// the signature via query parameters similar to WebSocket auth.
pub async fn upload_avatar(
    State(state): State<AppState>,
    signed: SignedRequest,
    mut multipart: Multipart,
) -> Result<Json<AvatarResponse>, (StatusCode, String)> {
    let user_handle = signed.user_id.split('@').next().unwrap_or(&signed.user_id);

    // Get the uploads directory
    let uploads_dir = get_uploads_dir()?;

    // Process multipart form
    while let Some(field) = multipart.next_field().await.map_err(|e| {
        (StatusCode::BAD_REQUEST, format!("Failed to read form: {}", e))
    })? {
        let name = field.name().unwrap_or("").to_string();

        if name != "avatar" {
            continue;
        }

        // Check content type
        let content_type = field.content_type().unwrap_or("application/octet-stream").to_string();
        if !ALLOWED_MIME_TYPES.contains(&content_type.as_str()) {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("Invalid file type: {}. Allowed: png, jpeg, gif, webp", content_type),
            ));
        }

        // Get file extension from content type
        let extension = match content_type.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            _ => return Err((StatusCode::BAD_REQUEST, "Unsupported file type".to_string())),
        };

        // Read file data
        let data = field.bytes().await.map_err(|e| {
            (StatusCode::BAD_REQUEST, format!("Failed to read file: {}", e))
        })?;

        // Check file size
        if data.len() > MAX_AVATAR_SIZE {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("File too large. Maximum size: {} bytes", MAX_AVATAR_SIZE),
            ));
        }

        // Generate unique filename
        let file_id = uuid::Uuid::new_v4();
        let filename = format!("{}_{}.{}", user_handle, file_id, extension);
        let file_path = uploads_dir.join(&filename);

        // Write file
        tokio::fs::write(&file_path, &data).await.map_err(|e| {
            tracing::error!("Failed to write avatar file: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to save file".to_string())
        })?;

        // Update user's avatar URL in database
        let avatar_url = format!("{}/uploads/avatars/{}", state.base_url, filename);

        // Find and update user
        let user_docs: Vec<_> = state.db
            .query("users")
            .filter(|f| f.eq("handle", user_handle.to_string()))
            .collect()
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

        if let Some(doc) = user_docs.into_iter().next() {
            state.db
                .update_document("users", &doc.id, vec![
                    ("avatar", avatar_url.clone().into()),
                    ("updated_at", chrono::Utc::now().to_rfc3339().into()),
                ])
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;
        }

        return Ok(Json(AvatarResponse { url: avatar_url }));
    }

    Err((StatusCode::BAD_REQUEST, "No avatar file provided".to_string()))
}

/// Get or create the uploads directory
fn get_uploads_dir() -> Result<PathBuf, (StatusCode, String)> {
    let base_dir = std::env::var("FORUMALL_UPLOADS_DIR")
        .unwrap_or_else(|_| "./uploads/avatars".to_string());
    let path = PathBuf::from(&base_dir);

    // Create directory if it doesn't exist
    if !path.exists() {
        std::fs::create_dir_all(&path).map_err(|e| {
            tracing::error!("Failed to create uploads directory: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to create uploads directory".to_string())
        })?;
    }

    Ok(path)
}
