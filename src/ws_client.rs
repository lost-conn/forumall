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

            let ws_url = auth.ws_url("/api/ws");
            // Placeholder: signature-based WS auth not yet fully implemented for browser query params
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
