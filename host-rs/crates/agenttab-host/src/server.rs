use crate::runtime::{request_lock_scope, RequestLockScope, Runtime};
use agenttab_protocol::{
    ConnectionInit, Outcome, RpcError, RpcMethod, RpcResponse, CLIENT_TO_HOST_MAX_BYTES,
    HOST_TO_CLIENT_MAX_BYTES,
};
#[cfg(all(test, unix))]
use agenttab_protocol::{PROTOCOL_VERSION, RPC_PROTOCOL};
#[cfg(unix)]
use fs2::FileExt;
use parking_lot::{Condvar, Mutex};
use serde_json::Value;
use std::collections::HashMap;
#[cfg(unix)]
use std::fs::{self, File, OpenOptions};
use std::io;
#[cfg(unix)]
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, Semaphore};
use tokio::task::JoinSet;

const MAX_CONNECTIONS: usize = 64;
const CONNECTION_QUEUE: usize = 32;
#[cfg(all(unix, not(test)))]
const OLD_HOST_EXIT_RETRY: std::time::Duration = std::time::Duration::from_secs(3);
#[cfg(all(unix, test))]
const OLD_HOST_EXIT_RETRY: std::time::Duration = std::time::Duration::from_millis(150);
#[cfg(unix)]
const OLD_HOST_EXIT_POLL: std::time::Duration = std::time::Duration::from_millis(50);

#[derive(Debug, Error)]
pub enum ServerError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[cfg(unix)]
    #[error("another AgentTab host owns {0}")]
    AlreadyRunning(PathBuf),
    #[cfg(windows)]
    #[error("another AgentTab host owns Windows mutex {0}")]
    AlreadyRunningWindows(String),
}

#[cfg(unix)]
#[derive(Debug)]
struct SocketGuard {
    socket_path: PathBuf,
    _lock: File,
}

#[cfg(unix)]
impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.socket_path);
    }
}
#[cfg(windows)]
#[derive(Debug)]
struct WindowsHostGuard {
    handle: isize,
}

#[cfg(windows)]
impl Drop for WindowsHostGuard {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::Threading::ReleaseMutex;

        unsafe {
            ReleaseMutex(self.handle as HANDLE);
            CloseHandle(self.handle as HANDLE);
        }
    }
}

#[cfg(unix)]
pub async fn serve_unix(runtime: Arc<Runtime>, socket_path: PathBuf) -> Result<(), ServerError> {
    let (_guard, listener) = bind_private_socket(&socket_path)?;
    let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut workers = JoinSet::new();
    loop {
        let permit = permits
            .clone()
            .acquire_owned()
            .await
            .expect("connection semaphore is never closed");
        let (stream, _) = listener.accept().await?;
        if !peer_is_current_user(&stream) {
            continue;
        }
        let runtime = runtime.clone();
        workers.spawn(async move {
            let _permit = permit;
            let _ = handle_connection(runtime, stream).await;
        });
        while workers.try_join_next().is_some() {}
    }
}

#[cfg(unix)]
fn bind_private_socket(socket_path: &Path) -> Result<(SocketGuard, UnixListener), ServerError> {
    let parent = socket_path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "socket path has no parent"))?;
    fs::create_dir_all(parent)?;
    let parent_metadata = fs::symlink_metadata(parent)?;
    if !parent_metadata.file_type().is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "refusing to use non-directory or symlinked runtime path {}",
                parent.display()
            ),
        )
        .into());
    }
    if !socket_owned_by_current_user(&parent_metadata) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("refusing to use unowned runtime path {}", parent.display()),
        )
        .into());
    }
    set_mode(parent, 0o700)?;

    let lock_path = parent.join("host.lock");
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)?;
    let retry_deadline = std::time::Instant::now() + OLD_HOST_EXIT_RETRY;
    loop {
        match lock.try_lock_exclusive() {
            Ok(()) => break,
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock
                    && std::time::Instant::now() < retry_deadline =>
            {
                std::thread::sleep(OLD_HOST_EXIT_POLL);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                return Err(ServerError::AlreadyRunning(lock_path));
            }
            Err(error) => return Err(error.into()),
        }
    }
    set_mode(&lock_path, 0o600)?;

    if socket_path.exists() {
        use std::os::unix::fs::FileTypeExt;

        let metadata = fs::symlink_metadata(socket_path)?;
        if !metadata.file_type().is_socket() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!(
                    "refusing to replace non-socket path {}",
                    socket_path.display()
                ),
            )
            .into());
        }
        if !socket_owned_by_current_user(&metadata) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "refusing to replace unowned socket {}",
                    socket_path.display()
                ),
            )
            .into());
        }
        if std::os::unix::net::UnixStream::connect(socket_path).is_ok() {
            return Err(ServerError::AlreadyRunning(lock_path));
        }
        fs::remove_file(socket_path)?;
    }
    let listener = UnixListener::bind(socket_path)?;
    set_mode(socket_path, 0o600)?;
    Ok((
        SocketGuard {
            socket_path: socket_path.to_path_buf(),
            _lock: lock,
        },
        listener,
    ))
}

#[cfg(windows)]
pub async fn serve_windows(runtime: Arc<Runtime>) -> Result<(), ServerError> {
    use tokio::task::JoinSet;

    let current_sid = current_user_sid()?;
    let _host_guard = acquire_windows_host_lock(&current_sid)?;
    let pipe_name = windows_pipe_name(&current_sid)?;
    let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut workers = JoinSet::new();
    let mut first = true;
    loop {
        let permit = permits
            .clone()
            .acquire_owned()
            .await
            .expect("connection semaphore is never closed");
        let server = create_windows_pipe(&pipe_name, &current_sid, first)?;
        first = false;
        server.connect().await?;
        if verify_windows_pipe_client(&server, &current_sid).is_err() {
            continue;
        }
        let runtime = runtime.clone();
        workers.spawn(async move {
            let _permit = permit;
            let _ = handle_connection(runtime, server).await;
        });
        while workers.try_join_next().is_some() {}
    }
}

#[cfg(windows)]
fn acquire_windows_host_lock(current_user_sid: &str) -> Result<WindowsHostGuard, ServerError> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;

    let name = format!(
        r"Local\AgentTabHost-{}",
        validated_windows_sid(current_user_sid)?
    );
    let wide_name = OsStr::new(&name)
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let handle = unsafe { CreateMutexW(null_mut(), 1, wide_name.as_ptr()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error().into());
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe {
            CloseHandle(handle);
        }
        return Err(ServerError::AlreadyRunningWindows(name));
    }
    Ok(WindowsHostGuard {
        handle: handle as isize,
    })
}

#[cfg(windows)]
fn validated_windows_sid(current_user_sid: &str) -> io::Result<&str> {
    let sid = current_user_sid.trim();
    let components = sid.strip_prefix("S-1-");
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
    Ok(sid)
}

#[cfg(windows)]
pub fn windows_pipe_name(current_user_sid: &str) -> io::Result<String> {
    Ok(format!(
        r"\\.\pipe\agenttab-{}",
        validated_windows_sid(current_user_sid)?
    ))
}

#[cfg(windows)]
fn create_windows_pipe(
    pipe_name: &str,
    current_user_sid: &str,
    first: bool,
) -> io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use std::ffi::{c_void, OsStr};
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use tokio::net::windows::named_pipe::ServerOptions;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;

    let sddl = format!(
        "D:P(A;;GA;;;SY)(A;;GA;;;{})",
        validated_windows_sid(current_user_sid)?
    );
    let sddl_wide = OsStr::new(&sddl)
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut descriptor: *mut c_void = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut security = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(first)
        .reject_remote_clients(true)
        .max_instances(MAX_CONNECTIONS)
        .in_buffer_size(64 * 1024)
        .out_buffer_size(64 * 1024);
    let result = unsafe {
        options.create_with_security_attributes_raw(
            pipe_name,
            (&mut security as *mut SECURITY_ATTRIBUTES).cast(),
        )
    };
    unsafe {
        LocalFree(descriptor);
    }
    result
}

#[cfg(windows)]
fn current_user_sid() -> io::Result<String> {
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    sid_for_windows_process(unsafe { GetCurrentProcess() })
}

#[cfg(windows)]
fn verify_windows_pipe_client(
    pipe: &tokio::net::windows::named_pipe::NamedPipeServer,
    expected_sid: &str,
) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    let mut client_process_id = 0;
    if unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle().cast(), &mut client_process_id) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, client_process_id) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    let actual_sid = sid_for_windows_process(process);
    unsafe {
        CloseHandle(process);
    }
    if actual_sid? != expected_sid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "named-pipe client belongs to a different Windows user",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn sid_for_windows_process(process: windows_sys::Win32::Foundation::HANDLE) -> io::Result<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::OpenProcessToken;

    let mut token = null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let result = (|| {
        let mut required = 0;
        unsafe {
            GetTokenInformation(token, TokenUser, null_mut(), 0, &mut required);
        }
        if required == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut token_user = vec![0_u8; required as usize];
        if unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                token_user.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let sid = unsafe { (*(token_user.as_ptr().cast::<TOKEN_USER>())).User.Sid };
        let mut sid_text = null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut sid_text) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut length = 0;
        while unsafe { *sid_text.add(length) } != 0 {
            length += 1;
        }
        let text = unsafe {
            OsString::from_wide(std::slice::from_raw_parts(sid_text, length))
                .to_string_lossy()
                .into_owned()
        };
        unsafe {
            LocalFree(sid_text.cast());
        }
        Ok(text)
    })();
    unsafe {
        CloseHandle(token);
    }
    result
}

#[derive(Debug, Default)]
struct OrderedQueue {
    state: Mutex<OrderedQueueState>,
    ready: Condvar,
}

#[derive(Debug, Default)]
struct OrderedQueueState {
    issued: u64,
    serving: u64,
}

impl OrderedQueue {
    fn issue(&self) -> u64 {
        let mut state = self.state.lock();
        let ticket = state.issued;
        state.issued = state
            .issued
            .checked_add(1)
            .expect("connection request ticket overflow");
        ticket
    }

    fn wait_turn(&self, ticket: u64) -> OrderedQueueGuard<'_> {
        let mut state = self.state.lock();
        while state.serving != ticket {
            self.ready.wait(&mut state);
        }
        OrderedQueueGuard { queue: self }
    }
}

struct OrderedQueueGuard<'a> {
    queue: &'a OrderedQueue,
}

impl Drop for OrderedQueueGuard<'_> {
    fn drop(&mut self) {
        let mut state = self.queue.state.lock();
        state.serving = state
            .serving
            .checked_add(1)
            .expect("connection request ticket overflow");
        self.queue.ready.notify_all();
    }
}

fn request_queue_scope(request: &Value) -> RequestLockScope {
    let Some(method) = request
        .get("method")
        .cloned()
        .and_then(|value| serde_json::from_value::<RpcMethod>(value).ok())
    else {
        return RequestLockScope::Global;
    };
    request_lock_scope(method, request.get("params").unwrap_or(&Value::Null))
}

async fn handle_connection<S>(runtime: Arc<Runtime>, mut stream: S) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let Some(init_value) = read_frame_async(&mut stream, CLIENT_TO_HOST_MAX_BYTES).await? else {
        return Ok(());
    };
    let init = ConnectionInit::parse(init_value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let (connection, ack) = runtime
        .connect(init)
        .map_err(|error| io::Error::other(error.to_string()))?;
    if let Err(error) = write_frame_async(
        &mut stream,
        &serde_json::to_value(ack)?,
        HOST_TO_CLIENT_MAX_BYTES,
    )
    .await
    {
        let _ = runtime.disconnect(&connection);
        return Err(error);
    }

    let (mut reader, mut writer) = tokio::io::split(stream);
    let (response_sender, mut response_receiver) = mpsc::channel::<Value>(CONNECTION_QUEUE);
    let writer_runtime = runtime.clone();
    let writer_connection = connection.clone();
    let writer = tokio::spawn(async move {
        while let Some(response) = response_receiver.recv().await {
            if write_frame_async(&mut writer, &response, HOST_TO_CLIENT_MAX_BYTES)
                .await
                .is_err()
            {
                let _ = writer_runtime.disconnect(&writer_connection);
                break;
            }
        }
    });

    let request_permits = Arc::new(Semaphore::new(CONNECTION_QUEUE));
    let mut request_queues = HashMap::<RequestLockScope, Arc<OrderedQueue>>::new();
    let mut requests = JoinSet::new();
    loop {
        let request = match read_frame_async(&mut reader, CLIENT_TO_HOST_MAX_BYTES).await {
            Ok(Some(request)) => request,
            Ok(None) | Err(_) => break,
        };
        let Ok(permit) = request_permits.clone().try_acquire_owned() else {
            let request_id = request
                .get("request_id")
                .and_then(Value::as_str)
                .unwrap_or("overloaded-request");
            let response = RpcResponse::failure(
                request_id,
                Outcome::NotStarted,
                RpcError::new(
                    "connection_queue_full",
                    format!(
                        "AgentTab allows at most {CONNECTION_QUEUE} in-flight requests per connection"
                    ),
                )
                .with_recovery("Wait for an in-flight request to finish before retrying."),
            )
            .value();
            if response_sender.send(response).await.is_err() {
                break;
            }
            continue;
        };
        request_queues.retain(|_, queue| Arc::strong_count(queue) > 1);
        let queue = request_queues
            .entry(request_queue_scope(&request))
            .or_insert_with(|| Arc::new(OrderedQueue::default()))
            .clone();
        let ticket = queue.issue();
        let request_runtime = runtime.clone();
        let request_connection = connection.clone();
        let request_responses = response_sender.clone();
        requests.spawn(async move {
            let _permit = permit;
            let response = tokio::task::spawn_blocking(move || {
                let _turn = queue.wait_turn(ticket);
                request_runtime.handle(&request_connection, request)
            })
            .await;
            if let Ok(response) = response {
                let _ = request_responses.send(response).await;
            }
        });
        while requests.try_join_next().is_some() {}
    }
    let _ = runtime.disconnect(&connection);
    requests.abort_all();
    while requests.join_next().await.is_some() {}
    drop(response_sender);
    writer.abort();
    let _ = writer.await;
    Ok(())
}

async fn read_frame_async<R: AsyncRead + Unpin>(
    reader: &mut R,
    max_bytes: usize,
) -> io::Result<Option<Value>> {
    let mut header = [0_u8; 4];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_le_bytes(header) as usize;
    if length > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame length {length} exceeds {max_bytes} bytes"),
        ));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload).await?;
    serde_json::from_slice(&payload)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

async fn write_frame_async<W: AsyncWrite + Unpin>(
    writer: &mut W,
    value: &Value,
    max_bytes: usize,
) -> io::Result<()> {
    let payload = serde_json::to_vec(value)?;
    if payload.len() > max_bytes || payload.len() > u32::MAX as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("frame length {} exceeds {max_bytes} bytes", payload.len()),
        ));
    }
    writer
        .write_all(&(payload.len() as u32).to_le_bytes())
        .await?;
    writer.write_all(&payload).await?;
    writer.flush().await
}
#[cfg(test)]
mod queue_tests {
    use super::*;

    #[test]
    fn ordered_queue_runs_workers_in_issue_order() {
        let queue = Arc::new(OrderedQueue::default());
        let first_ticket = queue.issue();
        let second_ticket = queue.issue();
        let order = Arc::new(Mutex::new(Vec::new()));
        let (started_sender, started_receiver) = std::sync::mpsc::channel();

        let second_queue = queue.clone();
        let second_order = order.clone();
        let second = std::thread::spawn(move || {
            started_sender.send(()).unwrap();
            let _turn = second_queue.wait_turn(second_ticket);
            second_order.lock().push(second_ticket);
        });
        started_receiver.recv().unwrap();

        let first_queue = queue.clone();
        let first_order = order.clone();
        let first = std::thread::spawn(move || {
            let _turn = first_queue.wait_turn(first_ticket);
            first_order.lock().push(first_ticket);
        });

        first.join().unwrap();
        second.join().unwrap();
        assert_eq!(*order.lock(), vec![first_ticket, second_ticket]);
    }
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(unix)]
fn socket_owned_by_current_user(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.uid() == unsafe { libc::geteuid() }
}

#[cfg(unix)]
fn peer_is_current_user(stream: &UnixStream) -> bool {
    peer_uid(stream).is_some_and(|uid| uid == unsafe { libc::geteuid() })
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly"
))]
fn peer_uid(stream: &UnixStream) -> Option<libc::uid_t> {
    use std::os::fd::AsRawFd;
    let mut uid = 0;
    let mut gid = 0;
    let result = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    (result == 0).then_some(uid)
}

#[cfg(target_os = "linux")]
fn peer_uid(stream: &UnixStream) -> Option<libc::uid_t> {
    use std::mem::size_of;
    use std::os::fd::AsRawFd;
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    };
    (result == 0).then_some(credentials.uid)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::handoff::HandoffState;
    use crate::lifecycle::Lifecycle;
    use crate::native::{NativeError, NativeTransport};
    use crate::paths::AgentTabPaths;
    use agenttab_protocol::{NativeResponse, Outcome};
    use std::time::Duration;
    use uuid::Uuid;

    #[derive(Debug)]
    struct UnusedNative;

    impl NativeTransport for UnusedNative {
        fn dispatch(
            &self,
            _connection_id: Uuid,
            _task_id: Uuid,
            _method: &str,
            _params: Value,
            _timeout: Duration,
        ) -> Result<NativeResponse, NativeError> {
            Err(NativeError::Disconnected)
        }
    }

    #[tokio::test]
    async fn private_socket_accepts_same_uid_and_status_request() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AgentTabPaths::from_root(temp.path().join("agenttab"));
        let lifecycle = Arc::new(Lifecycle::default());
        let runtime = Runtime::open(
            &paths,
            lifecycle,
            Arc::new(UnusedNative),
            Arc::new(HandoffState::default()),
        )
        .unwrap();
        let socket = temp.path().join("run/agenttab.sock");
        let server_runtime = runtime.clone();
        let server_socket = socket.clone();
        let server = tokio::spawn(async move {
            let _ = serve_unix(server_runtime, server_socket).await;
        });
        for _ in 0..100 {
            if socket.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let mut client = UnixStream::connect(&socket).await.unwrap();
        write_frame_async(
            &mut client,
            &serde_json::to_value(ConnectionInit {
                protocol: RPC_PROTOCOL.into(),
                version: PROTOCOL_VERSION,
                kind: agenttab_protocol::ConnectKind::Connect,
                conversation_id: None,
                resume_capability: None,
            })
            .unwrap(),
            CLIENT_TO_HOST_MAX_BYTES,
        )
        .await
        .unwrap();
        let ack = read_frame_async(&mut client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ack["kind"], "connected");
        write_frame_async(
            &mut client,
            &serde_json::json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "status",
                "method": "agenttab.status",
                "params": {}
            }),
            CLIENT_TO_HOST_MAX_BYTES,
        )
        .await
        .unwrap();
        let response = read_frame_async(&mut client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response["outcome"], serde_json::json!(Outcome::Completed));
        server.abort();
    }

    #[test]
    fn private_socket_rejects_symlinked_runtime_directory() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        fs::create_dir(&target).unwrap();
        let runtime_link = temp.path().join("run");
        symlink(&target, &runtime_link).unwrap();
        let error = bind_private_socket(&runtime_link.join("agenttab.sock")).unwrap_err();
        assert!(matches!(
            &error,
            ServerError::Io(inner) if inner.kind() == io::ErrorKind::InvalidInput
        ));
        assert!(!target.join("agenttab.sock").exists());
    }
}
