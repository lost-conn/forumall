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

pub fn use_ws() -> WsContext {
    use_context::<WsContext>()
}

#[component]
pub fn WsProvider(children: Element) -> Element {
    let auth = use_context::<AuthContext>();
    let token_str = auth.token().unwrap_or_default();

    rsx! {
        WsConnection { key: "{token_str}", children }
    }
}

#[component]
fn WsConnection(children: Element) -> Element {
    let auth = use_context::<AuthContext>();

    let ws = use_websocket(move || {
        let auth = auth.clone();
        async move {
            use dioxus_fullstack::http::{Extensions, HeaderMap, Method};

            // Fail early if not authenticated to avoid 401 errors
            let token = auth.token().ok_or_else(|| {
                dioxus::CapturedError::from_display("Authentication required for WebSocket")
            })?;

            let ws_url = auth.ws_url("/api/ws");
            // Pass token in query param because browser WebSockets don't support custom headers
            let ws_url = format!("{}?access_token={}", ws_url, token);
            let url = ws_url.parse().expect("Invalid URL");

            let mut headers = HeaderMap::new();
            headers.insert(
                dioxus_fullstack::http::header::AUTHORIZATION,
                format!("Bearer {}", token).parse().unwrap(),
            );

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
