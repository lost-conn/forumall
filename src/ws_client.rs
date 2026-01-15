use crate::auth_session::AuthContext;
use crate::models::{ClientCommand, ServerEvent, WsEnvelope};
use dioxus::prelude::*;
use dioxus_fullstack::{
    use_websocket, ClientRequest, FromResponse, IntoRequest, UseWebsocket, WebSocketOptions,
    Websocket,
};

#[derive(Clone, Copy)]
pub struct WsContext {
    pub ws: UseWebsocket<WsEnvelope<ClientCommand>, WsEnvelope<ServerEvent>>,
    pub last_event: Signal<Option<WsEnvelope<ServerEvent>>>,
}

pub fn use_ws() -> Option<WsContext> {
    try_use_context::<WsContext>()
}

#[component]
pub fn WsProvider(children: Element) -> Element {
    let auth = use_context::<AuthContext>();

    // Don't create WebSocket connection if not authenticated
    // This prevents borrow conflicts when logging out
    if !auth.is_authenticated() {
        return children;
    }

    let user_id = auth.user_id().unwrap_or_default();

    rsx! {
        WsConnection { key: "{user_id}", children }
    }
}

#[component]
fn WsConnection(children: Element) -> Element {
    let auth = use_context::<AuthContext>();

    let ws = use_websocket(move || {
        let auth = auth.clone();
        async move {
            use dioxus_fullstack::http::{Extensions, HeaderMap, Method};

            let base_ws_url = auth.ws_url("/api/ws");

            // Generate signed URL if authenticated
            let ws_url = if let Some(session) = auth.session.read().as_ref() {
                if let Some(keys) = &session.keys {
                    let domain = auth.provider_domain.read().clone();
                    if let Some(params) =
                        crate::auth::client_keys::sign_ws_request("/api/ws", keys, &session.user_id, &domain)
                    {
                        format!("{}?{}", base_ws_url, params.to_query_string())
                    } else {
                        base_ws_url
                    }
                } else {
                    base_ws_url
                }
            } else {
                base_ws_url
            };

            let url = ws_url.parse().expect("Invalid URL");
            let headers = HeaderMap::new();

            let request = ClientRequest {
                url,
                headers,
                method: Method::GET,
                extensions: Extensions::new(),
            };

            let options = WebSocketOptions::default();

            let upgrading = options
                .into_request(request)
                .await
                .map_err(|e| dioxus::CapturedError::from_display(format!("{e:?}")))?;

            let websocket: Websocket<WsEnvelope<ClientCommand>, WsEnvelope<ServerEvent>> =
                Websocket::from_response(upgrading)
                    .await
                    .map_err(|e| dioxus::CapturedError::from_display(format!("{e:?}")))?;

            Ok::<_, dioxus::CapturedError>(websocket)
        }
    });

    let mut last_event = use_signal(|| None);

    use_future(move || {
        let mut ws = ws.clone();
        async move {
            while let Ok(msg) = ws.recv().await {
                last_event.set(Some(msg));
            }
        }
    });

    use_context_provider(|| WsContext { ws, last_event });

    children
}
