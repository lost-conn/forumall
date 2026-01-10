use crate::api_client::{ApiClient, ApiError};
use crate::auth::{LoginResponse, RegisterRequest};
use crate::auth_session::AuthContext;
use crate::components::ui::{Button, ButtonVariant, Card, CardBody, CardHeader, TextInput};
use crate::Route;

use dioxus::prelude::*;

#[component]
pub fn Register() -> Element {
    let mut auth = use_context::<AuthContext>();
    let mut domain = use_signal(|| auth.provider_domain.read().clone());
    let mut handle = use_signal(|| String::new());
    let mut password = use_signal(|| String::new());
    let mut error = use_signal(|| None::<String>);
    let mut is_submitting = use_signal(|| false);
    let nav = use_navigator();

    rsx! {
        div { class: "min-h-screen pt-16 bg-gradient-to-br from-[#0f0f1a] via-[#1a1a2e] to-[#16213e] flex items-center justify-center px-4 py-12",
            div { class: "absolute inset-0 overflow-hidden pointer-events-none",
                div { class: "absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-600/10 rounded-full blur-3xl" }
                div { class: "absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl" }
            }

            div { class: "relative w-full max-w-md",
                Card { class: "backdrop-blur-sm bg-[#1e1f22]/80 border-[#2d2f34]",
                    CardHeader {
                        title: "Create an account".to_string(),
                        subtitle: Some("Join the OFSCP network".to_string()),
                    }
                    CardBody {
                        if let Some(e) = error.cloned() {
                            div { class: "mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg",
                                p { class: "text-sm text-red-400", "{e}" }
                            }
                        }

                        form {
                            class: "space-y-5",
                            onsubmit: move |e| async move {
                                e.stop_propagation();
                                e.prevent_default();
                                if is_submitting() {
                                    return;
                                }

                                is_submitting.set(true);
                                error.set(None);

                                let handle_value = handle.read().clone();
                                if !crate::models::validate_resource_name(&handle_value) {
                                    error.set(Some("Invalid handle. Must be lowercase alphanumeric, periods, underscores, or dashes.".to_string()));
                                    is_submitting.set(false);
                                    return;
                                }

                                // Persist provider domain (OFSCP endpoints are standardized; no discovery fetch needed).
                                let current_domain = domain.read().clone();
                                auth.provider_domain.set(current_domain);

                                // 2. Generate Key Pair locally
                                let keys = crate::auth::client_keys::generate_keypair();

                                // 3. Perform registration with atomic device key registration
                                let register_url = auth.api_url("/api/auth/register");
                                let client = ApiClient::new();
                                let req = RegisterRequest {
                                    handle: handle.cloned(),
                                    password: password.cloned(),
                                    device_public_key: Some(keys.public_key.clone()),
                                    device_name: Some("Web Browser".to_string()),
                                };

                                match client.post_json::<RegisterRequest, LoginResponse>(&register_url, &req).await {
                                    Ok(res) => {
                                        let mut final_keys = keys;
                                        final_keys.key_id = res.key_id;

                                        auth.login_with_keys(res.user_id, Some(final_keys));
                                        nav.push(Route::Home {});
                                    }
                                    Err(ApiError::Http { status, body }) => {
                                        let msg = crate::problem::try_problem_detail(&body)
                                            .unwrap_or_else(|| body);
                                        error.set(Some(format!("Registration failed ({status}): {msg}")));
                                    }
                                    Err(e) => error.set(Some(format!("Registration failed: {e:?}"))),
                                }
                                is_submitting.set(false);
                            },
                            div {
                                label { class: "block text-sm font-medium text-gray-300 mb-2",
                                    "Provider Domain"
                                }
                                TextInput {
                                    value: domain.cloned(),
                                    placeholder: Some("localhost".to_string()),
                                    oninput: move |e: FormEvent| domain.set(e.value()),
                                }
                            }
                            div {
                                label { class: "block text-sm font-medium text-gray-300 mb-2",
                                    "Handle"
                                }
                                TextInput {
                                    value: handle.cloned(),
                                    placeholder: Some("@username".to_string()),
                                    oninput: move |e: FormEvent| handle.set(e.value()),
                                }
                            }
                            div {
                                label { class: "block text-sm font-medium text-gray-300 mb-2",
                                    "Password"
                                }
                                TextInput {
                                    value: password.cloned(),
                                    placeholder: Some("••••••••".to_string()),
                                    input_type: Some(crate::components::ui::InputType::Password),
                                    oninput: move |e: FormEvent| password.set(e.value()),
                                }
                            }
                            Button {
                                r#type: Some("submit".to_string()),
                                variant: Some(ButtonVariant::Primary),
                                class: Some("w-full py-2.5".to_string()),
                                disabled: Some(is_submitting()),
                                if is_submitting() {
                                    "Creating…"
                                } else {
                                    "Create account"
                                }
                            }
                        }

                        div { class: "mt-6 text-center",
                            p { class: "text-sm text-gray-400",
                                "Already have an account? "
                                Link {
                                    class: "text-indigo-400 hover:text-indigo-300 font-medium transition-colors",
                                    to: Route::Login {},
                                    "Sign in"
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
