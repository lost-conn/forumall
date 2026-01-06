#[cfg(feature = "server")]
use dioxus_fullstack::http::HeaderValue;
#[cfg(feature = "server")]
use dioxus_fullstack::http::header::{ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_HEADERS};

#[cfg(feature = "server")]
pub fn apply_cors_headers(headers: &mut dioxus_fullstack::http::HeaderMap) {
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS, PUT, DELETE"));
    headers.insert(ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Authorization, Content-Type, Idempotency-Key"));
}
