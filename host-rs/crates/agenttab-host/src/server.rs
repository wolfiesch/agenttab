use crate::runtime::{request_lock_scope, RequestLockScope, Runtime};
use agenttab_protocol::{
    ConnectionInit, Outcome, ResumeCapabilityConfirm, RpcError, RpcMethod, RpcResponse,
    CLIENT_TO_HOST_MAX_BYTES, HOST_TO_CLIENT_MAX_BYTES,
};
#[cfg(all(test, unix))]
use agenttab_protocol::{PROTOCOL_VERSION, RPC_PROTOCOL};
#[cfg(unix)]
use fs2::FileExt;
#[cfg(test)]
use parking_lot::Condvar;
use parking_lot::Mutex;
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
use tokio::sync::{mpsc, oneshot, watch, Notify, Semaphore};
use tokio::task::JoinSet;

const MAX_CONNECTIONS: usize = 64;
const CONNECTION_QUEUE: usize = 32;
#[cfg(all(unix, not(test)))]
const OLD_HOST_EXIT_RETRY: std::time::Duration = std::time::Duration::from_secs(3);
#[cfg(all(unix, test))]
const OLD_HOST_EXIT_RETRY: std::time::Duration = std::time::Duration::from_millis(150);
#[cfg(unix)]
const OLD_HOST_EXIT_POLL: std::time::Duration = std::time::Duration::from_millis(50);
const INVALID_RESUME_CAPABILITY_ERROR: &str = "invalid_resume_capability";

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
pub(crate) fn create_windows_pipe(
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
pub(crate) fn current_user_sid() -> io::Result<String> {
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    sid_for_windows_process(unsafe { GetCurrentProcess() })
}

#[cfg(windows)]
pub(crate) fn verify_windows_pipe_client(
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

#[derive(Debug)]
struct OrderedQueue {
    state: Mutex<OrderedQueueState>,
    ready: watch::Sender<u64>,
}

#[derive(Debug, Default)]
struct OrderedQueueState {
    issued: u64,
    serving: u64,
}

impl Default for OrderedQueue {
    fn default() -> Self {
        let (ready, _) = watch::channel(0);
        Self {
            state: Mutex::new(OrderedQueueState::default()),
            ready,
        }
    }
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

    async fn wait_turn(self: &Arc<Self>, ticket: u64) -> OrderedQueueGuard {
        let mut ready = self.ready.subscribe();
        loop {
            if *ready.borrow_and_update() == ticket {
                return OrderedQueueGuard {
                    queue: Arc::clone(self),
                };
            }
            ready
                .changed()
                .await
                .expect("connection request queue sender dropped");
        }
    }
}

struct OrderedQueueGuard {
    queue: Arc<OrderedQueue>,
}

impl Drop for OrderedQueueGuard {
    fn drop(&mut self) {
        let serving = {
            let mut state = self.queue.state.lock();
            state.serving = state
                .serving
                .checked_add(1)
                .expect("connection request ticket overflow");
            state.serving
        };
        self.queue.ready.send_replace(serving);
    }
}

struct PendingResponse {
    value: Value,
    delivery: Option<oneshot::Sender<bool>>,
}

impl PendingResponse {
    fn untracked(value: Value) -> Self {
        Self {
            value,
            delivery: None,
        }
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
    let resume_capability_supplied = init.resume_capability.is_some();
    let (connection, ack) = runtime
        .connect(init)
        .map_err(|error| io::Error::other(error.to_string()))?;
    if let Err(error) = write_frame_async(
        &mut stream,
        &serde_json::to_value(&ack)?,
        HOST_TO_CLIENT_MAX_BYTES,
    )
    .await
    {
        let _ = runtime.disconnect(&connection);
        return Err(error);
    }
    if resume_capability_supplied && !ack.resumed {
        let _ = runtime.disconnect(&connection);
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            INVALID_RESUME_CAPABILITY_ERROR,
        ));
    }
    if connection.resume_confirmation_required() {
        let confirmation_value = match read_frame_async(&mut stream, CLIENT_TO_HOST_MAX_BYTES).await
        {
            Ok(Some(value)) => value,
            Ok(None) => {
                let _ = runtime.disconnect(&connection);
                return Ok(());
            }
            Err(error) => {
                let _ = runtime.disconnect(&connection);
                return Err(error);
            }
        };
        let confirmation = match ResumeCapabilityConfirm::parse(confirmation_value) {
            Ok(confirmation) => confirmation,
            Err(error) => {
                let _ = runtime.disconnect(&connection);
                return Err(io::Error::new(io::ErrorKind::InvalidData, error));
            }
        };
        let confirmed = match runtime.confirm_resume_capability(&connection, &confirmation) {
            Ok(confirmed) => confirmed,
            Err(error) => {
                let _ = runtime.disconnect(&connection);
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, error));
            }
        };
        if let Err(error) =
            write_frame_async(&mut stream, &confirmed.value(), HOST_TO_CLIENT_MAX_BYTES).await
        {
            let _ = runtime.disconnect(&connection);
            return Err(error);
        }
    }

    let mut bootstrap_complete = ack.resumed;
    let bootstrap_queue = Arc::new(OrderedQueue::default());
    let bootstrap_notify = Arc::new(Notify::new());
    let (mut reader, mut writer) = tokio::io::split(stream);
    let (response_sender, mut response_receiver) =
        mpsc::channel::<PendingResponse>(CONNECTION_QUEUE);
    let writer_runtime = runtime.clone();
    let writer_connection = connection.clone();
    let writer = tokio::spawn(async move {
        while let Some(PendingResponse { value, delivery }) = response_receiver.recv().await {
            let carries_capability = response_carries_new_capability(&value);
            let delivered = write_frame_async(&mut writer, &value, HOST_TO_CLIENT_MAX_BYTES)
                .await
                .is_ok();
            if carries_capability {
                writer_connection.finish_new_capability_delivery(delivered);
            }
            if let Some(delivery) = delivery {
                let _ = delivery.send(delivered);
            }
            if !delivered {
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
        if request.get("kind").and_then(Value::as_str) == Some("resume_confirm") {
            let confirmation = match ResumeCapabilityConfirm::parse(request) {
                Ok(confirmation) => confirmation,
                Err(_) => break,
            };
            let confirmed = match runtime.confirm_resume_capability(&connection, &confirmation) {
                Ok(confirmed) => confirmed,
                Err(_) => break,
            };
            if response_sender
                .send(PendingResponse::untracked(confirmed.value()))
                .await
                .is_err()
            {
                break;
            }
            bootstrap_complete = true;
            bootstrap_notify.notify_one();
            continue;
        }
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
            if response_sender
                .send(PendingResponse::untracked(response))
                .await
                .is_err()
            {
                break;
            }
            continue;
        };
        let bootstrap_turn = if bootstrap_complete {
            None
        } else {
            let ticket = bootstrap_queue.issue();
            Some((bootstrap_queue.clone(), ticket))
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
        let delivery_connection = connection.clone();
        let request_bootstrap_notify = bootstrap_notify.clone();
        requests.spawn(async move {
            let _permit = permit;
            let bootstrap_guard = match bootstrap_turn {
                Some((queue, ticket)) => Some(queue.wait_turn(ticket).await),
                None => None,
            };
            if bootstrap_guard.is_some() {
                loop {
                    let notified = request_bootstrap_notify.notified();
                    if !request_connection.resume_confirmation_required() {
                        break;
                    }
                    notified.await;
                }
            }
            let blocking_connection = request_connection.clone();
            let queue_guard = queue.wait_turn(ticket).await;
            let response = tokio::task::spawn_blocking(move || {
                let _turn = queue_guard;
                request_runtime.handle(&blocking_connection, request)
            })
            .await;
            if let Ok(response) = response {
                let carries_capability = response_carries_new_capability(&response);
                let (delivery, receipt) = if bootstrap_guard.is_some() {
                    let (delivery, receipt) = oneshot::channel();
                    (Some(delivery), Some(receipt))
                } else {
                    (None, None)
                };
                if request_responses
                    .send(PendingResponse {
                        value: response,
                        delivery,
                    })
                    .await
                    .is_err()
                {
                    if carries_capability {
                        delivery_connection.finish_new_capability_delivery(false);
                    }
                    return;
                }
                if let Some(receipt) = receipt {
                    let _ = receipt.await;
                }
            }
        });
        while requests.try_join_next().is_some() {}
    }
    requests.abort_all();
    while requests.join_next().await.is_some() {}
    drop(response_sender);
    writer.abort();
    let _ = writer.await;
    let _ = runtime.disconnect(&connection);
    Ok(())
}

fn response_carries_new_capability(response: &Value) -> bool {
    response
        .pointer("/task/resume_capability")
        .and_then(Value::as_str)
        .is_some()
}

pub(crate) async fn read_frame_async<R: AsyncRead + Unpin>(
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

    #[tokio::test]
    async fn ordered_queue_runs_workers_in_issue_order() {
        let queue = Arc::new(OrderedQueue::default());
        let first_ticket = queue.issue();
        let second_ticket = queue.issue();
        let order = Arc::new(Mutex::new(Vec::new()));
        let (started_sender, started_receiver) = oneshot::channel();

        let second_queue = queue.clone();
        let second_order = order.clone();
        let second = tokio::spawn(async move {
            started_sender.send(()).unwrap();
            let _turn = second_queue.wait_turn(second_ticket).await;
            second_order.lock().push(second_ticket);
        });
        started_receiver.await.unwrap();

        let first_queue = queue.clone();
        let first_order = order.clone();
        let first = tokio::spawn(async move {
            let _turn = first_queue.wait_turn(first_ticket).await;
            first_order.lock().push(first_ticket);
        });

        first.await.unwrap();
        second.await.unwrap();
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
pub(crate) fn peer_is_current_user(stream: &UnixStream) -> bool {
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
    use agenttab_protocol::{NativeResponse, NativeResponseKind, Outcome, NATIVE_PROTOCOL};
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
            _origin_policy: Option<agenttab_protocol::NativeOriginPolicy>,
            _timeout: Duration,
        ) -> Result<NativeResponse, NativeError> {
            Err(NativeError::Disconnected)
        }
    }

    #[derive(Debug, Default)]
    struct BlockingOpenNative {
        state: Mutex<BlockingOpenState>,
        ready: Condvar,
    }

    #[derive(Debug, Default)]
    struct BlockingOpenState {
        started: bool,
        released: bool,
    }

    impl BlockingOpenNative {
        fn wait_until_started(&self) {
            let mut state = self.state.lock();
            while !state.started {
                self.ready.wait(&mut state);
            }
        }

        fn release(&self) {
            let mut state = self.state.lock();
            state.released = true;
            self.ready.notify_all();
        }
    }

    impl NativeTransport for BlockingOpenNative {
        fn dispatch(
            &self,
            _connection_id: Uuid,
            _task_id: Uuid,
            method: &str,
            _params: Value,
            _origin_policy: Option<agenttab_protocol::NativeOriginPolicy>,
            _timeout: Duration,
        ) -> Result<NativeResponse, NativeError> {
            if method == "browser_open" {
                let mut state = self.state.lock();
                state.started = true;
                self.ready.notify_all();
                while !state.released {
                    self.ready.wait(&mut state);
                }
            }
            Ok(NativeResponse {
                protocol: NATIVE_PROTOCOL.into(),
                version: PROTOCOL_VERSION,
                kind: NativeResponseKind::Response,
                request_id: Uuid::now_v7(),
                outcome: Outcome::Completed,
                result: Some(serde_json::json!({"tab_id": 1})),
                error: None,
                staged: None,
            })
        }
    }

    fn test_runtime(temp: &tempfile::TempDir) -> (Arc<Runtime>, AgentTabPaths) {
        test_runtime_with_native(temp, Arc::new(UnusedNative))
    }

    fn test_runtime_with_native(
        temp: &tempfile::TempDir,
        native: Arc<dyn NativeTransport>,
    ) -> (Arc<Runtime>, AgentTabPaths) {
        let paths = AgentTabPaths::from_root(temp.path().join("agenttab"));
        let lifecycle = Arc::new(Lifecycle::default());
        lifecycle.complete_reconciliation(false);
        let runtime =
            Runtime::open(&paths, lifecycle, native, Arc::new(HandoffState::default())).unwrap();
        (runtime, paths)
    }

    fn connection_init(resume_capability: Option<String>) -> ConnectionInit {
        ConnectionInit {
            protocol: RPC_PROTOCOL.into(),
            version: PROTOCOL_VERSION,
            kind: agenttab_protocol::ConnectKind::Connect,
            conversation_id: None,
            resume_capability,
        }
    }

    async fn start_test_connection(
        runtime: Arc<Runtime>,
    ) -> (
        tokio::io::DuplexStream,
        tokio::task::JoinHandle<io::Result<()>>,
    ) {
        let (client, stream) = tokio::io::duplex(16 * 1024);
        let server = tokio::spawn(handle_connection(runtime, stream));
        (client, server)
    }

    async fn write_browser_open(client: &mut tokio::io::DuplexStream, request_id: &str) {
        write_frame_async(
            client,
            &serde_json::json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": request_id,
                "idempotency_key": Uuid::now_v7(),
                "method": "browser_open",
                "params": {"mode": "create"}
            }),
            CLIENT_TO_HOST_MAX_BYTES,
        )
        .await
        .unwrap();
    }

    fn task_count(paths: &AgentTabPaths) -> i64 {
        rusqlite::Connection::open(&paths.state_db)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .unwrap()
    }

    #[tokio::test]
    async fn explicit_invalid_resume_capability_closes_before_a_pipelined_rpc_can_create_a_task() {
        let temp = tempfile::tempdir().unwrap();
        let (runtime, paths) = test_runtime(&temp);
        let (mut client, server) = start_test_connection(runtime).await;
        write_frame_async(
            &mut client,
            &serde_json::to_value(connection_init(Some("x".repeat(32)))).unwrap(),
            CLIENT_TO_HOST_MAX_BYTES,
        )
        .await
        .unwrap();
        write_browser_open(&mut client, "pipelined-browser-open").await;

        let rejected = read_frame_async(&mut client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rejected["kind"], "connected");
        assert_eq!(rejected["resumed"], false);
        assert!(read_frame_async(&mut client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .is_none());
        let error = server.await.unwrap().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(error.to_string(), INVALID_RESUME_CAPABILITY_ERROR);
        assert_eq!(task_count(&paths), 0);
    }

    #[tokio::test]
    async fn pipelined_rpcs_wait_for_initial_capability_confirmation() {
        let temp = tempfile::tempdir().unwrap();
        let native = Arc::new(BlockingOpenNative::default());
        let (runtime, paths) = test_runtime_with_native(&temp, native.clone());
        let (mut client, server) = start_test_connection(runtime).await;
        write_frame_async(
            &mut client,
            &serde_json::to_value(connection_init(None)).unwrap(),
            CLIENT_TO_HOST_MAX_BYTES,
        )
        .await
        .unwrap();
        let acknowledgement = read_frame_async(&mut client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();

        write_browser_open(&mut client, "create-task").await;
        write_frame_async(
            &mut client,
            &serde_json::json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "pipelined-snapshot",
                "method": "browser_snapshot",
                "params": {"mode": "text", "tab_id": 999}
            }),
            CLIENT_TO_HOST_MAX_BYTES,
        )
        .await
        .unwrap();
        let waiting_native = native.clone();
        tokio::time::timeout(
            Duration::from_secs(1),
            tokio::task::spawn_blocking(move || waiting_native.wait_until_started()),
        )
        .await
        .unwrap()
        .unwrap();

        let premature = tokio::time::timeout(
            Duration::from_millis(150),
            read_frame_async(&mut client, HOST_TO_CLIENT_MAX_BYTES),
        )
        .await;
        native.release();
        assert!(
            premature.is_err(),
            "a pipelined request completed before the initial capability was delivered"
        );

        let created = read_frame_async(&mut client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(created["request_id"], "create-task");
        let capability = created["task"]["resume_capability"]
            .as_str()
            .unwrap()
            .to_owned();
        write_frame_async(
            &mut client,
            &serde_json::json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "kind": "resume_confirm",
                "connection_id": acknowledgement["connection_id"],
                "resume_capability": capability
            }),
            CLIENT_TO_HOST_MAX_BYTES,
        )
        .await
        .unwrap();
        let confirmed = read_frame_async(&mut client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(confirmed["kind"], "resume_confirmed");
        let deferred = read_frame_async(&mut client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(deferred["request_id"], "pipelined-snapshot");
        assert_eq!(task_count(&paths), 1);
        drop(client);
        assert!(server.await.unwrap().is_ok());
    }
    #[tokio::test]
    async fn initial_capability_confirmation_unlocks_follow_up_rpcs() {
        let temp = tempfile::tempdir().unwrap();
        let (runtime, paths) = test_runtime(&temp);
        let (mut client, server) = start_test_connection(runtime).await;
        write_frame_async(
            &mut client,
            &serde_json::to_value(connection_init(None)).unwrap(),
            CLIENT_TO_HOST_MAX_BYTES,
        )
        .await
        .unwrap();
        let acknowledgement = read_frame_async(&mut client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();
        write_browser_open(&mut client, "create-task").await;
        let created = read_frame_async(&mut client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();
        let capability = created["task"]["resume_capability"]
            .as_str()
            .unwrap()
            .to_owned();

        write_frame_async(
            &mut client,
            &serde_json::json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "kind": "resume_confirm",
                "connection_id": acknowledgement["connection_id"],
                "resume_capability": capability
            }),
            CLIENT_TO_HOST_MAX_BYTES,
        )
        .await
        .unwrap();
        let confirmed = read_frame_async(&mut client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(confirmed["kind"], "resume_confirmed");
        assert_eq!(confirmed["connection_id"], acknowledgement["connection_id"]);

        write_frame_async(
            &mut client,
            &serde_json::json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "confirmed-status",
                "method": "agenttab.status",
                "params": {}
            }),
            CLIENT_TO_HOST_MAX_BYTES,
        )
        .await
        .unwrap();
        let status = read_frame_async(&mut client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status["outcome"], serde_json::json!(Outcome::Completed));
        assert_eq!(task_count(&paths), 1);
        drop(client);
        assert!(server.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn no_capability_creates_a_task_and_valid_resume_confirmation_still_works() {
        let temp = tempfile::tempdir().unwrap();
        let (runtime, paths) = test_runtime(&temp);
        let (mut client, server) = start_test_connection(runtime.clone()).await;
        write_frame_async(
            &mut client,
            &serde_json::to_value(connection_init(None)).unwrap(),
            CLIENT_TO_HOST_MAX_BYTES,
        )
        .await
        .unwrap();
        let acknowledgement = read_frame_async(&mut client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(acknowledgement["kind"], "connected");
        assert_eq!(acknowledgement["resumed"], false);
        write_browser_open(&mut client, "create-task").await;
        let created = read_frame_async(&mut client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();
        let task_id = created["task"]["task_id"].as_str().unwrap().to_owned();
        let initial_capability = created["task"]["resume_capability"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(task_count(&paths), 1);
        drop(client);
        assert!(server.await.unwrap().is_ok());

        let (mut resumed_client, resumed_server) = start_test_connection(runtime.clone()).await;
        write_frame_async(
            &mut resumed_client,
            &serde_json::to_value(connection_init(Some(initial_capability.clone()))).unwrap(),
            CLIENT_TO_HOST_MAX_BYTES,
        )
        .await
        .unwrap();
        let resumed = read_frame_async(&mut resumed_client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(resumed["kind"], "connected");
        assert_eq!(resumed["resumed"], true);
        assert_eq!(resumed["task_id"], task_id);
        let replacement_capability = resumed["resume_capability"].as_str().unwrap();
        assert_ne!(replacement_capability, initial_capability);
        write_frame_async(
            &mut resumed_client,
            &serde_json::json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "kind": "resume_confirm",
                "connection_id": resumed["connection_id"],
                "resume_capability": replacement_capability
            }),
            CLIENT_TO_HOST_MAX_BYTES,
        )
        .await
        .unwrap();
        let confirmed = read_frame_async(&mut resumed_client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(confirmed["kind"], "resume_confirmed");
        assert_eq!(confirmed["connection_id"], resumed["connection_id"]);
        write_frame_async(
            &mut resumed_client,
            &serde_json::json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "resumed-status",
                "method": "agenttab.status",
                "params": {}
            }),
            CLIENT_TO_HOST_MAX_BYTES,
        )
        .await
        .unwrap();
        let status = read_frame_async(&mut resumed_client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status["outcome"], serde_json::json!(Outcome::Completed));
        assert_eq!(status["result"]["task_id"], task_id);
        drop(resumed_client);
        assert!(resumed_server.await.unwrap().is_ok());

        let (mut expired_client, expired_server) = start_test_connection(runtime).await;
        write_frame_async(
            &mut expired_client,
            &serde_json::to_value(connection_init(Some(initial_capability))).unwrap(),
            CLIENT_TO_HOST_MAX_BYTES,
        )
        .await
        .unwrap();
        write_browser_open(&mut expired_client, "expired-browser-open").await;
        let rejected = read_frame_async(&mut expired_client, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rejected["kind"], "connected");
        assert_eq!(rejected["resumed"], false);
        assert!(
            read_frame_async(&mut expired_client, HOST_TO_CLIENT_MAX_BYTES)
                .await
                .unwrap()
                .is_none()
        );
        let error = expired_server.await.unwrap().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(error.to_string(), INVALID_RESUME_CAPABILITY_ERROR);
        assert_eq!(task_count(&paths), 1);
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
