use crate::native::StdioNative;
use crate::paths::AgentTabPaths;
use agenttab_protocol::EXTENSION_TO_HOST_MAX_BYTES;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

const DAEMON_CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const DAEMON_CONNECT_RETRY: Duration = Duration::from_millis(50);

#[derive(Clone)]
struct RelayWriter {
    sender: mpsc::UnboundedSender<Vec<u8>>,
}

impl Write for RelayWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.sender.send(buffer.to_vec()).map_err(|_| {
            io::Error::new(io::ErrorKind::BrokenPipe, "native relay connection closed")
        })?;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

async fn serve_connection<S>(native: Arc<StdioNative>, stream: S) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut reader, mut writer) = tokio::io::split(stream);
    let (sender, mut outbound) = mpsc::unbounded_channel::<Vec<u8>>();
    let generation = native
        .attach_writer(RelayWriter { sender })
        .map_err(|error| io::Error::new(io::ErrorKind::AlreadyExists, error))?;

    let reader_native = native.clone();
    let reader_task = async move {
        loop {
            let value =
                match crate::server::read_frame_async(&mut reader, EXTENSION_TO_HOST_MAX_BYTES)
                    .await
                {
                    Ok(Some(value)) => value,
                    Ok(None) => return Ok::<(), String>(()),
                    Err(error) => return Err(error.to_string()),
                };
            reader_native
                .receive_generation(generation, value)
                .map_err(|error| error.to_string())?;
        }
    };
    let writer_task = async move {
        while let Some(bytes) = outbound.recv().await {
            writer.write_all(&bytes).await?;
            writer.flush().await?;
        }
        Ok::<(), io::Error>(())
    };
    tokio::pin!(reader_task);
    tokio::pin!(writer_task);

    let result = tokio::select! {
        result = &mut reader_task => match result {
            Ok(()) => Ok(()),
            Err(error) => {
                native.disconnect_generation(generation, "native relay protocol failed", Some(error.clone()));
                Err(io::Error::new(io::ErrorKind::InvalidData, error))
            }
        },
        result = &mut writer_task => result,
    };
    native.disconnect_generation(generation, "native relay connection closed", None);
    result
}

fn spawn_connection<S>(
    native: Arc<StdioNative>,
    stream: S,
    fatal_sender: mpsc::UnboundedSender<io::Error>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        if let Err(error) = serve_connection(native, stream).await {
            if error.kind() == io::ErrorKind::InvalidData {
                let _ = fatal_sender.send(error);
            }
        }
    });
}

#[cfg(unix)]
#[derive(Debug)]
struct RelaySocketGuard {
    path: PathBuf,
}

#[cfg(unix)]
impl Drop for RelaySocketGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(unix)]
fn bind_relay_socket(path: &Path) -> io::Result<(RelaySocketGuard, tokio::net::UnixListener)> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};

    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "relay path has no parent"))?;
    let parent_metadata = std::fs::symlink_metadata(parent)?;
    if !parent_metadata.is_dir()
        || parent_metadata.file_type().is_symlink()
        || parent_metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "native relay directory must be owned by the current user",
        ));
    }
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
    if path.exists() {
        let metadata = std::fs::symlink_metadata(path)?;
        if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "refusing to replace an unsafe native relay path",
            ));
        }
        if std::os::unix::net::UnixStream::connect(path).is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                "another AgentTab daemon owns the native relay",
            ));
        }
        std::fs::remove_file(path)?;
    }
    let listener = tokio::net::UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok((
        RelaySocketGuard {
            path: path.to_path_buf(),
        },
        listener,
    ))
}

#[cfg(unix)]
pub async fn serve(native: Arc<StdioNative>, paths: &AgentTabPaths) -> io::Result<()> {
    let (_guard, listener) = bind_relay_socket(&paths.native_socket_file)?;
    let (fatal_sender, mut fatal_receiver) = mpsc::unbounded_channel();
    loop {
        let (stream, _) = tokio::select! {
            error = fatal_receiver.recv() => return Err(error.expect("relay worker channel remains open")),
            accepted = listener.accept() => accepted?,
        };
        if !crate::server::peer_is_current_user(&stream) {
            continue;
        }
        // One Chrome Native Messaging port owns the relay at a time. A queued
        // reconnect is rejected quickly rather than hanging behind the active port.
        spawn_connection(native.clone(), stream, fatal_sender.clone());
    }
}

#[cfg(windows)]
pub async fn serve(native: Arc<StdioNative>, _paths: &AgentTabPaths) -> io::Result<()> {
    let sid = crate::server::current_user_sid()?;
    let pipe_name = windows_native_pipe_name(&sid)?;
    let mut first = true;
    let (fatal_sender, mut fatal_receiver) = mpsc::unbounded_channel();
    loop {
        let pipe = crate::server::create_windows_pipe(&pipe_name, &sid, first)?;
        first = false;
        tokio::select! {
            error = fatal_receiver.recv() => return Err(error.expect("relay worker channel remains open")),
            connected = pipe.connect() => connected?,
        }
        if crate::server::verify_windows_pipe_client(&pipe, &sid).is_err() {
            continue;
        }
        spawn_connection(native.clone(), pipe, fatal_sender.clone());
    }
}

pub fn windows_native_pipe_name(sid: &str) -> io::Result<String> {
    let components = sid.trim().strip_prefix("S-1-");
    if components.is_none_or(|components| {
        components.is_empty()
            || components.split('-').any(|component| {
                component.is_empty() || !component.bytes().all(|byte| byte.is_ascii_digit())
            })
    }) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "current-user SID must use the canonical S-1-... form",
        ));
    }
    Ok(format!(r"\\.\pipe\agenttab-native-{}", sid.trim()))
}

fn daemon_executable(shim: &Path) -> PathBuf {
    shim.with_file_name(if cfg!(windows) {
        "agenttab-host.exe"
    } else {
        "agenttab-host"
    })
}

fn spawn_daemon(host: &Path, state_root: &Path) -> io::Result<()> {
    std::process::Command::new(host)
        .arg("daemon")
        .env("AGENTTAB_STATE_DIR", state_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
}

async fn relay_stdio<S>(stream: S) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mut relay_reader, mut relay_writer) = tokio::io::split(stream);
    let (stdin_sender, mut stdin_receiver) = mpsc::unbounded_channel::<io::Result<Vec<u8>>>();
    std::thread::Builder::new()
        .name("agenttab-native-stdin".into())
        .spawn(move || {
            let stdin = io::stdin();
            let mut input = stdin.lock();
            let mut buffer = vec![0_u8; 16 * 1024];
            loop {
                match input.read(&mut buffer) {
                    Ok(0) => return,
                    Ok(count) => {
                        if stdin_sender.send(Ok(buffer[..count].to_vec())).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = stdin_sender.send(Err(error));
                        return;
                    }
                }
            }
        })?;
    let mut stdout = tokio::io::stdout();
    let stdin_to_relay = async move {
        while let Some(chunk) = stdin_receiver.recv().await {
            relay_writer.write_all(&chunk?).await?;
        }
        relay_writer.shutdown().await
    };
    tokio::select! {
        result = stdin_to_relay => result,
        result = tokio::io::copy(&mut relay_reader, &mut stdout) => {
            result?;
            stdout.flush().await
        },
    }
}

#[cfg(unix)]
async fn connect(paths: &AgentTabPaths) -> io::Result<tokio::net::UnixStream> {
    tokio::net::UnixStream::connect(&paths.native_socket_file).await
}

#[cfg(windows)]
async fn connect(
    _paths: &AgentTabPaths,
) -> io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    use tokio::net::windows::named_pipe::ClientOptions;

    let sid = crate::server::current_user_sid()?;
    ClientOptions::new().open(windows_native_pipe_name(&sid)?)
}

pub async fn run_shim(paths: AgentTabPaths, shim: PathBuf) -> io::Result<()> {
    let host = daemon_executable(&shim);
    let started_at = tokio::time::Instant::now();
    let mut started_daemon = false;
    loop {
        match connect(&paths).await {
            Ok(stream) => return relay_stdio(stream).await,
            Err(error) if started_at.elapsed() < DAEMON_CONNECT_TIMEOUT => {
                if !started_daemon {
                    spawn_daemon(&host, &paths.root).map_err(|spawn_error| {
                        io::Error::new(
                            spawn_error.kind(),
                            format!(
                                "native relay unavailable ({error}); failed to start {}: {spawn_error}",
                                host.display()
                            ),
                        )
                    })?;
                    started_daemon = true;
                }
                tokio::time::sleep(DAEMON_CONNECT_RETRY).await;
            }
            Err(error) => {
                return Err(io::Error::new(
                    error.kind(),
                    format!(
                        "AgentTab daemon did not expose its native relay within {} ms: {error}",
                        DAEMON_CONNECT_TIMEOUT.as_millis()
                    ),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HandoffState, Lifecycle};
    use agenttab_protocol::{
        write_frame, RuntimeState, HOST_TO_EXTENSION_MAX_BYTES, NATIVE_PROTOCOL, PROTOCOL_VERSION,
    };
    use serde_json::json;

    #[test]
    fn windows_relay_name_is_user_scoped_and_rejects_injection() {
        assert_eq!(
            windows_native_pipe_name("S-1-5-21-1000").unwrap(),
            r"\\.\pipe\agenttab-native-S-1-5-21-1000"
        );
        for invalid in ["", "S-1-", "S-1-5\\evil", "Global\\S-1-5"] {
            assert!(windows_native_pipe_name(invalid).is_err());
        }
    }

    #[cfg(unix)]
    async fn handshake<S>(stream: &mut S, paused: bool)
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        let hello = json!({
            "protocol": NATIVE_PROTOCOL,
            "version": PROTOCOL_VERSION,
            "kind": "hello",
            "extension_version": "0.2.0",
            "inventory": [],
            "paused": paused,
            "handoff": {"active": false},
            "staged_commits": []
        });
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &hello, EXTENSION_TO_HOST_MAX_BYTES).unwrap();
        stream.write_all(&bytes).await.unwrap();
        let ready = crate::server::read_frame_async(stream, HOST_TO_EXTENSION_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ready["kind"], "ready");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_relay_reconnects_without_restarting_the_daemon() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AgentTabPaths::from_root(temp.path().join("state"));
        paths.prepare().unwrap();
        let lifecycle = Arc::new(Lifecycle::default());
        let native =
            StdioNative::reconnectable(lifecycle.clone(), Arc::new(HandoffState::default()));
        let (mut first, first_server) = tokio::io::duplex(16 * 1024);
        let first_native = native.clone();
        let first_relay =
            tokio::spawn(async move { serve_connection(first_native, first_server).await });
        handshake(&mut first, false).await;
        assert_eq!(lifecycle.state(), RuntimeState::Ready);

        let (_second_while_active, competing_server) = tokio::io::duplex(1024);
        let competing_native = native.clone();
        let competing =
            tokio::spawn(async move { serve_connection(competing_native, competing_server).await });
        assert_eq!(
            competing.await.unwrap().unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );

        drop(first);
        first_relay.await.unwrap().unwrap();

        assert_eq!(lifecycle.state(), RuntimeState::Reconciling);

        let (mut second, second_server) = tokio::io::duplex(16 * 1024);
        let second_native = native.clone();
        let second_relay =
            tokio::spawn(async move { serve_connection(second_native, second_server).await });
        handshake(&mut second, true).await;
        assert_eq!(lifecycle.state(), RuntimeState::Paused);
        assert!(!second_relay.is_finished());
        drop(second);
        second_relay.await.unwrap().unwrap();
    }
}
