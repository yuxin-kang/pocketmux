use std::{
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use russh::{
    client,
    keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
    Disconnect,
};
use serde::{Deserialize, Serialize};
use tokio::{
    io::copy_bidirectional,
    net::{TcpListener, TcpStream},
    sync::{Mutex as AsyncMutex, Notify},
    time::{timeout, Duration},
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
const LOOPBACK_HOST: &str = "127.0.0.1";

pub struct SshTunnelManager {
    state: Mutex<TunnelState>,
    generation: AtomicU64,
}

struct TunnelState {
    active: Option<ActiveTunnel>,
}

impl Default for SshTunnelManager {
    fn default() -> Self {
        Self {
            state: Mutex::new(TunnelState { active: None }),
            generation: AtomicU64::new(0),
        }
    }
}

pub struct ActiveTunnel {
    local_port: u16,
    shutdown: Arc<Notify>,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelStartResult {
    pub local_url: String,
    pub host_key_fingerprint: String,
    pub jump_host_key_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshJumpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub key_passphrase: Option<String>,
    pub host_key_fingerprint: Option<String>,
}

struct SshClientHandler {
    expected_fingerprint: Option<String>,
    observed_fingerprint: Arc<Mutex<Option<String>>>,
}

impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        if let Ok(mut observed) = self.observed_fingerprint.lock() {
            *observed = Some(fingerprint.clone());
        }
        Ok(self.expected_fingerprint.as_deref() == Some(fingerprint.as_str()))
    }
}

fn validate_host_and_username(host: &str, username: &str) -> Result<(), String> {
    if host.trim().is_empty()
        || host.len() > 255
        || host
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err("ssh-invalid-host".into());
    }
    if username.trim().is_empty()
        || username.len() > 128
        || username
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err("ssh-invalid-username".into());
    }
    Ok(())
}

fn validate_ssh_inputs(
    host: &str,
    username: &str,
    remote_host: &str,
    remote_port: u16,
) -> Result<(), String> {
    validate_host_and_username(host, username)?;
    if remote_host != LOOPBACK_HOST || remote_port == 0 {
        return Err("ssh-remote-target-must-be-loopback".into());
    }
    Ok(())
}

fn scoped_error(scope: &str, suffix: &str) -> String {
    if scope.is_empty() {
        format!("ssh-{suffix}")
    } else {
        format!("ssh-{scope}-{suffix}")
    }
}

fn classify_connect_error(
    error: russh::Error,
    observed_fingerprint: &Arc<Mutex<Option<String>>>,
    expected_fingerprint: Option<&str>,
    scope: &str,
) -> String {
    let observed = observed_fingerprint
        .lock()
        .ok()
        .and_then(|fingerprint| fingerprint.clone());
    if let Some(fingerprint) = observed {
        let suffix = match expected_fingerprint {
            None => "host-key-untrusted",
            Some(expected) if expected == fingerprint => "connect-failed",
            Some(_) => "host-key-mismatch",
        };
        format!("{}:{fingerprint}", scoped_error(scope, suffix))
    } else {
        format!("{}:{error}", scoped_error(scope, "connect-failed"))
    }
}

async fn connect_checked<F>(
    future: F,
    observed_fingerprint: Arc<Mutex<Option<String>>>,
    expected_fingerprint: Option<&str>,
    scope: &str,
) -> Result<client::Handle<SshClientHandler>, String>
where
    F: Future<Output = Result<client::Handle<SshClientHandler>, russh::Error>>,
{
    timeout(CONNECT_TIMEOUT, future)
        .await
        .map_err(|_| scoped_error(scope, "connect-timeout"))?
        .map_err(|error| {
            classify_connect_error(error, &observed_fingerprint, expected_fingerprint, scope)
        })
}

async fn authenticate_session(
    session: &mut client::Handle<SshClientHandler>,
    username: &str,
    auth_method: &str,
    password: Option<&str>,
    private_key: Option<&str>,
    key_passphrase: Option<&str>,
    scope: &str,
) -> Result<(), String> {
    let auth_result = if auth_method == "password" {
        timeout(
            AUTH_TIMEOUT,
            session.authenticate_password(
                username.to_owned(),
                password.unwrap_or_default().to_owned(),
            ),
        )
        .await
        .map_err(|_| scoped_error(scope, "auth-timeout"))?
        .map_err(|error| format!("{}:{error}", scoped_error(scope, "auth-failed")))?
    } else {
        let key = russh::keys::decode_secret_key(private_key.unwrap_or_default(), key_passphrase)
            .map_err(|error| {
            format!("{}:{error}", scoped_error(scope, "private-key-invalid"))
        })?;
        let key = PrivateKeyWithHashAlg::new(
            Arc::new(key),
            session
                .best_supported_rsa_hash()
                .await
                .map_err(|error| {
                    format!("{}:{error}", scoped_error(scope, "key-algorithm-failed"))
                })?
                .flatten(),
        );
        timeout(
            AUTH_TIMEOUT,
            session.authenticate_publickey(username.to_owned(), key),
        )
        .await
        .map_err(|_| scoped_error(scope, "auth-timeout"))?
        .map_err(|error| format!("{}:{error}", scoped_error(scope, "auth-failed")))?
    };
    if !auth_result.success() {
        return Err(scoped_error(scope, "auth-rejected"));
    }
    Ok(())
}

fn stop_active_tunnel(manager: &SshTunnelManager) -> Result<(), String> {
    let active = manager
        .state
        .lock()
        .map_err(|_| "ssh-tunnel-state-unavailable".to_string())?
        .active
        .take();
    if let Some(active) = active {
        active.cancelled.store(true, Ordering::SeqCst);
        active.shutdown.notify_waiters();
    }
    Ok(())
}

async fn forward_connection(
    socket: TcpStream,
    session: Arc<AsyncMutex<client::Handle<SshClientHandler>>>,
    remote_port: u16,
) {
    let origin = match socket.peer_addr() {
        Ok(address) => address,
        Err(_) => return,
    };
    let channel = {
        let session = session.lock().await;
        session
            .channel_open_direct_tcpip(
                LOOPBACK_HOST,
                u32::from(remote_port),
                origin.ip().to_string(),
                u32::from(origin.port()),
            )
            .await
    };
    let Ok(channel) = channel else { return };
    let mut stream = channel.into_stream();
    let mut socket = socket;
    let _ = copy_bidirectional(&mut socket, &mut stream).await;
}

async fn disconnect_session(
    session: &Arc<AsyncMutex<client::Handle<SshClientHandler>>>,
    message: &str,
) {
    let session = session.lock().await;
    let _ = session
        .disconnect(Disconnect::ByApplication, message, "en")
        .await;
}

async fn disconnect_sessions(
    session: &Arc<AsyncMutex<client::Handle<SshClientHandler>>>,
    upstream: Option<&Arc<AsyncMutex<client::Handle<SshClientHandler>>>>,
) {
    disconnect_session(session, "Pocketmux tunnel stopped").await;
    if let Some(upstream) = upstream {
        disconnect_session(upstream, "Pocketmux jump tunnel stopped").await;
    }
}

async fn run_listener(
    listener: TcpListener,
    session: Arc<AsyncMutex<client::Handle<SshClientHandler>>>,
    remote_port: u16,
    shutdown: Arc<Notify>,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
    upstream: Option<Arc<AsyncMutex<client::Handle<SshClientHandler>>>>,
) {
    loop {
        if cancelled.load(Ordering::SeqCst) {
            disconnect_sessions(&session, upstream.as_ref()).await;
            break;
        }
        tokio::select! {
            _ = shutdown.notified() => {
                disconnect_sessions(&session, upstream.as_ref()).await;
                break;
            }
            accepted = listener.accept() => {
                let Ok((socket, _)) = accepted else {
                    disconnect_sessions(&session, upstream.as_ref()).await;
                    break;
                };
                let session = Arc::clone(&session);
                tokio::spawn(forward_connection(socket, session, remote_port));
            }
        }
    }
}

pub async fn start(
    manager: &SshTunnelManager,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    password: Option<String>,
    private_key: Option<String>,
    key_passphrase: Option<String>,
    remote_host: String,
    remote_port: u16,
    jump: Option<SshJumpConfig>,
    local_port: Option<u16>,
    host_key_fingerprint: Option<String>,
) -> Result<SshTunnelStartResult, String> {
    let generation = manager.generation.fetch_add(1, Ordering::SeqCst) + 1;
    validate_ssh_inputs(&host, &username, &remote_host, remote_port)?;
    if port == 0 {
        return Err("ssh-invalid-port".into());
    }
    if auth_method != "password" && auth_method != "privateKey" {
        return Err("ssh-invalid-auth-method".into());
    }
    if auth_method == "password" && password.as_deref().unwrap_or_default().is_empty() {
        return Err("ssh-password-required".into());
    }
    if auth_method == "privateKey" && private_key.as_deref().unwrap_or_default().trim().is_empty() {
        return Err("ssh-private-key-required".into());
    }
    if local_port == Some(0) {
        return Err("ssh-invalid-local-port".into());
    }

    if let Some(jump) = jump.as_ref() {
        validate_host_and_username(&jump.host, &jump.username)?;
        if jump.port == 0 {
            return Err("ssh-jump-invalid-port".into());
        }
        if jump.auth_method != "password" && jump.auth_method != "privateKey" {
            return Err("ssh-jump-invalid-auth-method".into());
        }
        if jump.auth_method == "password" && jump.password.as_deref().unwrap_or_default().is_empty()
        {
            return Err("ssh-jump-password-required".into());
        }
        if jump.auth_method == "privateKey"
            && jump
                .private_key
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
        {
            return Err("ssh-jump-private-key-required".into());
        }
    }

    let config = Arc::new(russh::client::Config {
        nodelay: true,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });

    let (mut session, upstream, observed_fingerprint, jump_observed_fingerprint) =
        if let Some(jump) = jump.as_ref() {
            let jump_observed = Arc::new(Mutex::new(None));
            let jump_handler = SshClientHandler {
                expected_fingerprint: jump.host_key_fingerprint.clone(),
                observed_fingerprint: Arc::clone(&jump_observed),
            };
            let mut jump_session = connect_checked(
                client::connect(
                    Arc::clone(&config),
                    (jump.host.as_str(), jump.port),
                    jump_handler,
                ),
                Arc::clone(&jump_observed),
                jump.host_key_fingerprint.as_deref(),
                "jump",
            )
            .await?;
            authenticate_session(
                &mut jump_session,
                &jump.username,
                &jump.auth_method,
                jump.password.as_deref(),
                jump.private_key.as_deref(),
                jump.key_passphrase.as_deref(),
                "jump",
            )
            .await?;

            let channel = timeout(
                CONNECT_TIMEOUT,
                jump_session.channel_open_direct_tcpip(
                    host.clone(),
                    u32::from(port),
                    LOOPBACK_HOST,
                    0,
                ),
            )
            .await
            .map_err(|_| "ssh-jump-target-connect-timeout".to_string())?
            .map_err(|error| format!("ssh-jump-target-connect-failed:{error}"))?;

            let observed = Arc::new(Mutex::new(None));
            let handler = SshClientHandler {
                expected_fingerprint: host_key_fingerprint.clone(),
                observed_fingerprint: Arc::clone(&observed),
            };
            let target_session = connect_checked(
                client::connect_stream(Arc::clone(&config), channel.into_stream(), handler),
                Arc::clone(&observed),
                host_key_fingerprint.as_deref(),
                "target",
            )
            .await?;
            (
                target_session,
                Some(Arc::new(AsyncMutex::new(jump_session))),
                observed,
                Some(jump_observed),
            )
        } else {
            let observed = Arc::new(Mutex::new(None));
            let handler = SshClientHandler {
                expected_fingerprint: host_key_fingerprint.clone(),
                observed_fingerprint: Arc::clone(&observed),
            };
            let session = connect_checked(
                client::connect(Arc::clone(&config), (host.as_str(), port), handler),
                Arc::clone(&observed),
                host_key_fingerprint.as_deref(),
                "",
            )
            .await?;
            (session, None, observed, None)
        };

    authenticate_session(
        &mut session,
        &username,
        &auth_method,
        password.as_deref(),
        private_key.as_deref(),
        key_passphrase.as_deref(),
        if jump.is_some() { "target" } else { "" },
    )
    .await?;

    let fingerprint = host_key_fingerprint
        .or_else(|| {
            observed_fingerprint
                .lock()
                .ok()
                .and_then(|value| value.clone())
        })
        .ok_or_else(|| "ssh-host-key-missing".to_string())?;
    let jump_fingerprint = match (jump.as_ref(), jump_observed_fingerprint) {
        (Some(jump), Some(observed)) => Some(
            jump.host_key_fingerprint
                .clone()
                .or_else(|| observed.lock().ok().and_then(|value| value.clone()))
                .ok_or_else(|| "ssh-jump-host-key-missing".to_string())?,
        ),
        (None, _) => None,
        (Some(_), None) => return Err("ssh-jump-host-key-missing".into()),
    };

    let listener = TcpListener::bind((LOOPBACK_HOST, local_port.unwrap_or(0)))
        .await
        .map_err(|error| format!("ssh-local-bind-failed:{error}"))?;
    let local_port = listener
        .local_addr()
        .map_err(|error| format!("ssh-local-address-failed:{error}"))?
        .port();
    let shutdown = Arc::new(Notify::new());
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let session = Arc::new(AsyncMutex::new(session));
    tokio::spawn(run_listener(
        listener,
        Arc::clone(&session),
        remote_port,
        Arc::clone(&shutdown),
        Arc::clone(&cancelled),
        upstream.clone(),
    ));

    let (installed, previous) = {
        let mut state = manager
            .state
            .lock()
            .map_err(|_| "ssh-tunnel-state-unavailable".to_string())?;
        if manager.generation.load(Ordering::SeqCst) != generation {
            (false, None)
        } else {
            (
                true,
                state.active.replace(ActiveTunnel {
                    local_port,
                    shutdown: Arc::clone(&shutdown),
                    cancelled: Arc::clone(&cancelled),
                }),
            )
        }
    };
    if !installed {
        cancelled.store(true, Ordering::SeqCst);
        shutdown.notify_waiters();
        return Err("ssh-tunnel-superseded".into());
    }
    if let Some(previous) = previous {
        previous.cancelled.store(true, Ordering::SeqCst);
        previous.shutdown.notify_waiters();
    }

    Ok(SshTunnelStartResult {
        local_url: format!("http://{LOOPBACK_HOST}:{local_port}/"),
        host_key_fingerprint: fingerprint,
        jump_host_key_fingerprint: jump_fingerprint,
    })
}

pub fn stop(manager: &SshTunnelManager) -> Result<(), String> {
    manager.generation.fetch_add(1, Ordering::SeqCst);
    stop_active_tunnel(manager)
}

pub fn status(manager: &SshTunnelManager) -> Result<Option<u16>, String> {
    Ok(manager
        .state
        .lock()
        .map_err(|_| "ssh-tunnel-state-unavailable".to_string())?
        .active
        .as_ref()
        .map(|active| active.local_port))
}

#[cfg(test)]
mod tests {
    use super::validate_ssh_inputs;

    #[test]
    fn only_loopback_remote_targets_are_allowed() {
        assert!(validate_ssh_inputs("host.example", "user", "127.0.0.1", 3789).is_ok());
        assert!(validate_ssh_inputs("host.example", "user", "localhost", 3789).is_err());
        assert!(validate_ssh_inputs("host.example", "user", "10.0.0.2", 3789).is_err());
    }

    #[test]
    fn shell_metacharacters_are_not_accepted_in_host_or_user() {
        assert!(validate_ssh_inputs("host;rm", "user", "127.0.0.1", 3789).is_err());
        assert!(validate_ssh_inputs("host", "user name", "127.0.0.1", 3789).is_err());
    }
}
