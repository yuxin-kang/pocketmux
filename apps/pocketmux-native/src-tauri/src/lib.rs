use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

macro_rules! auth_info {
    ($($arg:tt)*) => {{
        log::info!($($arg)*);
        #[cfg(target_os = "android")]
        eprintln!($($arg)*);
    }};
}

macro_rules! auth_error {
    ($($arg:tt)*) => {{
        log::error!($($arg)*);
        #[cfg(target_os = "android")]
        eprintln!($($arg)*);
    }};
}

use reqwest::StatusCode;
use serde::Deserialize;
#[cfg(desktop)]
use tauri::Manager;
use tauri_plugin_keyring_store::KeyringExt;

const POCKETMUX_PRODUCT: &str = "pocketmux";
const POCKETMUX_PROTOCOL_VERSION: u32 = 1;
const POCKETMUX_PRODUCT_HEADER: &str = "x-pocketmux-product";
const POCKETMUX_PROTOCOL_HEADER: &str = "x-pocketmux-protocol-version";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
    product: String,
    protocol_version: u32,
}

struct CredentialMutationLock(Arc<Mutex<()>>);
struct ShellSession(Mutex<Option<String>>);

fn authorize_shell_context(
    webview_label: &str,
    expected_session: Option<&str>,
    provided_session: &str,
) -> Result<(), String> {
    if webview_label != "main" {
        return Err("native command access is limited to the Pocketmux shell".into());
    }
    if expected_session != Some(provided_session) {
        return Err("native shell session is not authorized".into());
    }
    Ok(())
}

fn authorize_shell(
    webview: &tauri::WebviewWindow,
    shell_session: &tauri::State<'_, ShellSession>,
    provided_session: &str,
) -> Result<(), String> {
    let session = shell_session
        .0
        .lock()
        .map_err(|_| "native shell session is unavailable".to_string())?;
    authorize_shell_context(webview.label(), session.as_deref(), provided_session)
}

fn with_credential_lock<T>(
    lock: &Mutex<()>,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _guard = lock
        .lock()
        .map_err(|_| "credential mutation lock is unavailable".to_string())?;
    operation()
}

fn has_pocketmux_identity(headers: &reqwest::header::HeaderMap) -> bool {
    headers
        .get(POCKETMUX_PRODUCT_HEADER)
        .and_then(|value| value.to_str().ok())
        == Some(POCKETMUX_PRODUCT)
        && headers
            .get(POCKETMUX_PROTOCOL_HEADER)
            .and_then(|value| value.to_str().ok())
            == Some("1")
}

fn classify_token_validation(
    status: StatusCode,
    pocketmux_identity: bool,
    health: Option<&HealthResponse>,
) -> &'static str {
    match status {
        StatusCode::UNAUTHORIZED if pocketmux_identity => "invalid",
        status
            if status.is_success()
                && pocketmux_identity
                && health.is_some_and(|body| {
                    body.ok
                        && body.product == POCKETMUX_PRODUCT
                        && body.protocol_version == POCKETMUX_PROTOCOL_VERSION
                }) =>
        {
            "valid"
        }
        _ => "unknown",
    }
}

fn token_account(server_url: &str) -> String {
    format!("connection:{server_url}")
}

fn server_origin(server_url: &str) -> String {
    reqwest::Url::parse(server_url)
        .map(|url| {
            format!(
                "{}://{}{}",
                url.scheme(),
                url.host_str().unwrap_or("<unknown>"),
                url.port()
                    .map(|port| format!(":{port}"))
                    .unwrap_or_default()
            )
        })
        .unwrap_or_else(|_| "<invalid-url>".into())
}

fn health_url(base_url: &reqwest::Url) -> Result<reqwest::Url, ()> {
    base_url.join("api/health").map_err(|_| ())
}

#[tauri::command(rename_all = "camelCase")]
fn register_shell_session(
    webview: tauri::WebviewWindow,
    shell_session: tauri::State<'_, ShellSession>,
    session_token: String,
) -> Result<(), String> {
    if webview.label() != "main"
        || session_token.len() != 64
        || !session_token.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("invalid native shell session".into());
    }
    let mut session = shell_session
        .0
        .lock()
        .map_err(|_| "native shell session is unavailable".to_string())?;
    match session.as_deref() {
        Some(existing) if existing == session_token => Ok(()),
        Some(_) => Err("native shell session is already registered".into()),
        None => {
            *session = Some(session_token);
            Ok(())
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
fn exit_app(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    shell_session: tauri::State<'_, ShellSession>,
    session_token: String,
) -> Result<(), String> {
    authorize_shell(&webview, &shell_session, &session_token)?;
    app.exit(0);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn validate_token(
    webview: tauri::WebviewWindow,
    shell_session: tauri::State<'_, ShellSession>,
    session_token: String,
    server_url: String,
    token: String,
) -> Result<String, String> {
    authorize_shell(&webview, &shell_session, &session_token)?;
    let origin = server_origin(&server_url);
    auth_info!("[pocketmux-auth] native validation start origin={origin}");
    let Ok(base_url) = reqwest::Url::parse(&server_url) else {
        auth_info!("[pocketmux-auth] native validation result origin={origin} outcome=unknown reason=invalid-url");
        return Ok("unknown".into());
    };
    if !matches!(base_url.scheme(), "http" | "https") || token.trim().is_empty() {
        auth_info!("[pocketmux-auth] native validation result origin={origin} outcome=unknown reason=invalid-input");
        return Ok("unknown".into());
    }
    let Ok(health_url) = health_url(&base_url) else {
        auth_info!("[pocketmux-auth] native validation result origin={origin} outcome=unknown reason=health-url");
        return Ok("unknown".into());
    };
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        auth_info!("[pocketmux-auth] native validation result origin={origin} outcome=unknown reason=client");
        return Ok("unknown".into());
    };

    let outcome = match client.get(health_url).bearer_auth(token).send().await {
        Ok(response) => {
            let status = response.status();
            let pocketmux_identity = has_pocketmux_identity(response.headers());
            if !status.is_success() {
                auth_info!(
                    "[pocketmux-auth] native validation response origin={origin} status={} identity={pocketmux_identity}",
                    status.as_u16()
                );
                classify_token_validation(status, pocketmux_identity, None).into()
            } else {
                match response.json::<HealthResponse>().await {
                    Ok(health) => {
                        auth_info!(
                            "[pocketmux-auth] native validation response origin={origin} status={} identity={pocketmux_identity}",
                            status.as_u16()
                        );
                        classify_token_validation(status, pocketmux_identity, Some(&health)).into()
                    }
                    Err(_) => {
                        auth_info!(
                            "[pocketmux-auth] native validation body failed origin={origin} status={}",
                            status.as_u16()
                        );
                        "unknown".into()
                    }
                }
            }
        }
        Err(_) => {
            auth_info!("[pocketmux-auth] native validation request failed origin={origin}");
            "unknown".into()
        }
    };
    auth_info!("[pocketmux-auth] native validation result origin={origin} outcome={outcome}");
    Ok(outcome)
}

#[tauri::command(rename_all = "camelCase")]
async fn get_connection_tokens(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    shell_session: tauri::State<'_, ShellSession>,
    session_token: String,
    server_urls: Vec<String>,
) -> Result<Vec<Result<Option<String>, String>>, String> {
    authorize_shell(&webview, &shell_session, &session_token)?;
    auth_info!(
        "[pocketmux-auth] keyring read start servers={}",
        server_urls.len()
    );
    let store = app.keyring().store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        server_urls
            .into_iter()
            .map(|server_url| {
                let origin = server_origin(&server_url);
                let result = store
                    .get_password(&token_account(&server_url))
                    .map_err(|error| error.to_string());
                match &result {
                    Ok(Some(_)) => {
                        auth_info!("[pocketmux-auth] keyring read found origin={origin}")
                    }
                    Ok(None) => auth_info!("[pocketmux-auth] keyring read missing origin={origin}"),
                    Err(error) => auth_error!(
                        "[pocketmux-auth] keyring read failed origin={origin} error={error}"
                    ),
                }
                result
            })
            .collect()
    })
    .await
    .map_err(|error| {
        auth_error!("[pocketmux-auth] keyring read task failed error={error}");
        error.to_string()
    })
}

#[tauri::command(rename_all = "camelCase")]
async fn set_connection_token(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    shell_session: tauri::State<'_, ShellSession>,
    lock: tauri::State<'_, CredentialMutationLock>,
    session_token: String,
    server_url: String,
    token: String,
) -> Result<(), String> {
    authorize_shell(&webview, &shell_session, &session_token)?;
    if token.trim().is_empty() {
        return Err("token must not be empty".into());
    }
    let origin = server_origin(&server_url);
    auth_info!("[pocketmux-auth] keyring write start origin={origin}");
    let account = token_account(&server_url);
    let store = app.keyring().store.clone();
    let mutation_lock = Arc::clone(&lock.0);
    tauri::async_runtime::spawn_blocking(move || {
        with_credential_lock(&mutation_lock, || {
            store
                .set_password(&account, &token)
                .map_err(|error| error.to_string())
        })
    })
    .await
    .map_err(|error| {
        auth_error!("[pocketmux-auth] keyring write task failed origin={origin} error={error}");
        error.to_string()
    })?
    .map_err(|error| {
        auth_error!("[pocketmux-auth] keyring write failed origin={origin} error={error}");
        error
    })?;
    auth_info!("[pocketmux-auth] keyring write success origin={origin}");
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn delete_connection_token(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    shell_session: tauri::State<'_, ShellSession>,
    lock: tauri::State<'_, CredentialMutationLock>,
    session_token: String,
    server_url: String,
) -> Result<(), String> {
    authorize_shell(&webview, &shell_session, &session_token)?;
    let origin = server_origin(&server_url);
    auth_info!("[pocketmux-auth] keyring delete start origin={origin}");
    let account = token_account(&server_url);
    let store = app.keyring().store.clone();
    let mutation_lock = Arc::clone(&lock.0);
    tauri::async_runtime::spawn_blocking(move || {
        with_credential_lock(&mutation_lock, || {
            store.delete(&account).map_err(|error| error.to_string())
        })
    })
    .await
    .map_err(|error| {
        auth_error!("[pocketmux-auth] keyring delete task failed origin={origin} error={error}");
        error.to_string()
    })?
    .map_err(|error| {
        auth_error!("[pocketmux-auth] keyring delete failed origin={origin} error={error}");
        error
    })?;
    auth_info!("[pocketmux-auth] keyring delete success origin={origin}");
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn reject_connection_token(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    shell_session: tauri::State<'_, ShellSession>,
    lock: tauri::State<'_, CredentialMutationLock>,
    session_token: String,
    server_url: String,
    expected_token: String,
) -> Result<Option<String>, String> {
    authorize_shell(&webview, &shell_session, &session_token)?;
    let origin = server_origin(&server_url);
    auth_info!("[pocketmux-auth] keyring reject start origin={origin}");
    let account = token_account(&server_url);
    let store = app.keyring().store.clone();
    let mutation_lock = Arc::clone(&lock.0);
    tauri::async_runtime::spawn_blocking(move || {
        with_credential_lock(&mutation_lock, || {
            let stored_token = store
                .get_password(&account)
                .map_err(|error| error.to_string())?;
            if stored_token.as_deref() == Some(expected_token.as_str()) {
                store.delete(&account).map_err(|error| error.to_string())?;
                return Ok(None);
            }
            Ok(stored_token)
        })
    })
    .await
    .map_err(|error| {
        auth_error!("[pocketmux-auth] keyring reject task failed origin={origin} error={error}");
        error.to_string()
    })
    .and_then(|result| {
        match &result {
            Ok(Some(_)) => {
                auth_info!("[pocketmux-auth] keyring reject kept newer token origin={origin}")
            }
            Ok(None) => auth_info!("[pocketmux-auth] keyring reject deleted token origin={origin}"),
            Err(error) => {
                auth_error!("[pocketmux-auth] keyring reject failed origin={origin} error={error}")
            }
        }
        result
    })
}

#[cfg(test)]
mod tests {
    use super::{
        authorize_shell_context, classify_token_validation, has_pocketmux_identity, health_url,
        server_origin, token_account, with_credential_lock, HealthResponse,
    };
    use reqwest::{header::HeaderMap, StatusCode};
    use std::{
        sync::{mpsc, Arc, Mutex},
        thread,
        time::Duration,
    };

    #[test]
    fn only_an_explicit_unauthorized_response_rejects_a_saved_token() {
        assert_eq!(
            classify_token_validation(StatusCode::UNAUTHORIZED, true, None),
            "invalid"
        );
        assert_eq!(
            classify_token_validation(StatusCode::UNAUTHORIZED, false, None),
            "unknown"
        );
        assert_eq!(
            classify_token_validation(StatusCode::FORBIDDEN, true, None),
            "unknown"
        );
        assert_eq!(
            classify_token_validation(StatusCode::BAD_GATEWAY, false, None),
            "unknown"
        );
    }

    #[test]
    fn success_requires_the_pocketmux_health_identity() {
        let valid = HealthResponse {
            ok: true,
            product: "pocketmux".into(),
            protocol_version: 1,
        };
        let wrong_product = HealthResponse {
            ok: true,
            product: "other-app".into(),
            protocol_version: 1,
        };
        assert_eq!(
            classify_token_validation(StatusCode::OK, true, Some(&valid)),
            "valid"
        );
        assert_eq!(
            classify_token_validation(StatusCode::OK, true, Some(&wrong_product)),
            "unknown"
        );
        assert_eq!(
            classify_token_validation(StatusCode::OK, false, Some(&valid)),
            "unknown"
        );
        assert_eq!(
            classify_token_validation(StatusCode::OK, true, None),
            "unknown"
        );
    }

    #[test]
    fn response_identity_requires_both_pocketmux_headers() {
        let mut headers = HeaderMap::new();
        headers.insert("x-pocketmux-product", "pocketmux".parse().unwrap());
        assert!(!has_pocketmux_identity(&headers));
        headers.insert("x-pocketmux-protocol-version", "1".parse().unwrap());
        assert!(has_pocketmux_identity(&headers));
    }

    #[test]
    fn connection_accounts_are_stable_and_server_scoped() {
        assert_eq!(
            token_account("https://demo.example/tools/"),
            "connection:https://demo.example/tools/"
        );
    }

    #[test]
    fn diagnostic_server_labels_never_include_path_or_query_data() {
        assert_eq!(
            server_origin("https://demo.example/tools/?token=secret"),
            "https://demo.example"
        );
        assert_eq!(server_origin("not a url"), "<invalid-url>");
    }

    #[test]
    fn native_commands_require_the_main_shell_and_its_runtime_session() {
        assert!(authorize_shell_context("main", Some("secret"), "secret").is_ok());
        assert!(authorize_shell_context("remote", Some("secret"), "secret").is_err());
        assert!(authorize_shell_context("main", Some("secret"), "attacker").is_err());
        assert!(authorize_shell_context("main", None, "secret").is_err());
    }

    #[test]
    fn health_endpoint_preserves_a_reverse_proxy_base_path() {
        let base = reqwest::Url::parse("https://demo.example/tools/pocketmux/").unwrap();
        assert_eq!(
            health_url(&base).unwrap().as_str(),
            "https://demo.example/tools/pocketmux/api/health"
        );
    }

    #[test]
    fn credential_mutations_cannot_replace_a_token_between_compare_and_delete() {
        let operation_lock = Arc::new(Mutex::new(()));
        let stored_token = Arc::new(Mutex::new(Some("old-token".to_string())));
        let (read_tx, read_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (written_tx, written_rx) = mpsc::channel();

        let reject_lock = Arc::clone(&operation_lock);
        let reject_token = Arc::clone(&stored_token);
        let reject = thread::spawn(move || {
            with_credential_lock(&reject_lock, || {
                let current = reject_token.lock().unwrap().clone();
                read_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                if current.as_deref() == Some("old-token") {
                    *reject_token.lock().unwrap() = None;
                }
                Ok::<_, String>(())
            })
            .unwrap();
        });

        read_rx.recv().unwrap();
        let write_lock = Arc::clone(&operation_lock);
        let write_token = Arc::clone(&stored_token);
        let replace = thread::spawn(move || {
            with_credential_lock(&write_lock, || {
                *write_token.lock().unwrap() = Some("new-token".to_string());
                written_tx.send(()).unwrap();
                Ok::<_, String>(())
            })
            .unwrap();
        });

        assert!(written_rx.recv_timeout(Duration::from_millis(50)).is_err());
        release_tx.send(()).unwrap();
        reject.join().unwrap();
        replace.join().unwrap();
        assert_eq!(stored_token.lock().unwrap().as_deref(), Some("new-token"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    builder
        .manage(CredentialMutationLock(Arc::new(Mutex::new(()))))
        .manage(ShellSession(Mutex::new(None)))
        .plugin(tauri_plugin_keyring_store::init())
        .invoke_handler(tauri::generate_handler![
            register_shell_session,
            exit_app,
            validate_token,
            get_connection_tokens,
            set_connection_token,
            delete_connection_token,
            reject_connection_token
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Pocketmux");
}
