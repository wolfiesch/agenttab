use serde_json::Value;
use std::io;
use std::path::{Path, PathBuf};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const CLIENT_TO_HOST_MAX_BYTES: usize = 64 * 1024 * 1024;
pub const HOST_TO_CLIENT_MAX_BYTES: usize = 1024 * 1024;
pub const SOCKET_DIRECTORY_MODE: u32 = 0o700;
pub const SOCKET_MODE: u32 = 0o600;

#[derive(Debug, Error)]
pub enum ProbeError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("invalid JSON frame: {0}")]
    Json(#[from] serde_json::Error),
    #[error("declared frame length {declared} exceeds limit {limit}")]
    Oversize { declared: usize, limit: usize },
    #[error("invalid IPC boundary: {0}")]
    InvalidBoundary(String),
    #[error("peer uid {actual} is not allowed; expected {expected}")]
    PeerDenied { actual: u32, expected: u32 },
    #[error("named-pipe peer SID is not the current user")]
    PipePeerDenied,
}

pub async fn read_frame<R>(reader: &mut R, limit: usize) -> Result<Option<Value>, ProbeError>
where
    R: AsyncRead + Unpin,
{
    let mut header = [0_u8; 4];
    let first_read = reader.read(&mut header).await?;
    if first_read == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut header[first_read..]).await?;

    let declared = u32::from_le_bytes(header) as usize;
    if declared > limit {
        return Err(ProbeError::Oversize { declared, limit });
    }

    let mut payload = vec![0_u8; declared];
    reader.read_exact(&mut payload).await?;
    Ok(Some(serde_json::from_slice(&payload)?))
}

pub async fn write_frame<W>(writer: &mut W, value: &Value, limit: usize) -> Result<(), ProbeError>
where
    W: AsyncWrite + Unpin,
{
    let payload = serde_json::to_vec(value)?;
    let frame_ceiling = limit.min(u32::MAX as usize);
    if payload.len() > frame_ceiling {
        return Err(ProbeError::Oversize {
            declared: payload.len(),
            limit: frame_ceiling,
        });
    }
    writer
        .write_all(&(payload.len() as u32).to_le_bytes())
        .await?;
    writer.write_all(&payload).await?;
    writer.flush().await?;
    Ok(())
}

pub fn unix_socket_path(home: &Path, xdg_runtime_dir: Option<&Path>, current_uid: u32) -> PathBuf {
    if let Some(runtime_dir) = xdg_runtime_dir {
        if path_owned_by(runtime_dir, current_uid) {
            return runtime_dir.join("agenttab").join("agenttab.sock");
        }
    }
    home.join(".agenttab").join("run").join("agenttab.sock")
}

#[cfg(unix)]
fn path_owned_by(path: &Path, expected_uid: u32) -> bool {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path)
        .map(|metadata| metadata.uid() == expected_uid)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn path_owned_by(_path: &Path, _expected_uid: u32) -> bool {
    false
}

#[cfg(any(windows, test))]
fn validated_windows_sid(current_user_sid: &str) -> Result<&str, ProbeError> {
    let sid = current_user_sid;
    let sid_components = sid.strip_prefix("S-1-");
    if sid_components.is_none_or(|components| {
        components.is_empty()
            || components.split('-').any(|component| {
                component.is_empty() || !component.bytes().all(|byte| byte.is_ascii_digit())
            })
    }) {
        return Err(ProbeError::InvalidBoundary(
            "current-user SID must use the canonical S-1-... form".to_owned(),
        ));
    }
    Ok(sid)
}

#[cfg(any(windows, test))]
pub fn windows_pipe_name(current_user_sid: &str) -> Result<String, ProbeError> {
    Ok(format!(
        r"\\.\pipe\agenttab-{}",
        validated_windows_sid(current_user_sid)?
    ))
}

#[cfg(any(windows, test))]
fn windows_pipe_sddl(current_user_sid: &str) -> Result<String, ProbeError> {
    Ok(format!(
        "D:P(A;;GA;;;SY)(A;;GA;;;{})",
        validated_windows_sid(current_user_sid)?
    ))
}

#[cfg(test)]
mod framing_tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn frames_are_little_endian_json_and_fail_closed() {
        let (mut writer, mut reader) = tokio::io::duplex(64);
        let write_task = tokio::spawn(async move {
            write_frame(&mut writer, &json!("x"), CLIENT_TO_HOST_MAX_BYTES)
                .await
                .unwrap();
        });
        let mut wire = [0_u8; 7];
        reader.read_exact(&mut wire).await.unwrap();
        write_task.await.unwrap();
        assert_eq!(wire, [3, 0, 0, 0, b'"', b'x', b'"']);

        for limit in [CLIENT_TO_HOST_MAX_BYTES, HOST_TO_CLIENT_MAX_BYTES] {
            let (mut writer, mut reader) = tokio::io::duplex(8);
            writer
                .write_all(&((limit + 1) as u32).to_le_bytes())
                .await
                .unwrap();
            assert!(matches!(
                read_frame(&mut reader, limit).await.unwrap_err(),
                ProbeError::Oversize { declared, limit: actual_limit }
                    if declared == limit + 1 && actual_limit == limit
            ));
        }

        let (mut writer, mut reader) = tokio::io::duplex(8);
        writer.write_all(&[2, 0, 0, 0, 0xff, 0xff]).await.unwrap();
        assert!(matches!(
            read_frame(&mut reader, CLIENT_TO_HOST_MAX_BYTES)
                .await
                .unwrap_err(),
            ProbeError::Json(_)
        ));

        let (mut writer, mut reader) = tokio::io::duplex(8);
        writer.write_all(&[4, 0, 0, 0, b'{']).await.unwrap();
        drop(writer);
        assert!(matches!(
            read_frame(&mut reader, CLIENT_TO_HOST_MAX_BYTES)
                .await
                .unwrap_err(),
            ProbeError::Io(error) if error.kind() == io::ErrorKind::UnexpectedEof
        ));

        let (mut writer, _reader) = tokio::io::duplex(1);
        assert!(matches!(
            write_frame(&mut writer, &json!("x"), 2).await.unwrap_err(),
            ProbeError::Oversize {
                declared: 3,
                limit: 2
            }
        ));
    }

    #[test]
    fn windows_identity_values_are_not_command_or_acl_injection_surfaces() {
        let sid = "S-1-5-21-123-456-789-1001";
        assert_eq!(
            windows_pipe_name(sid).unwrap(),
            r"\\.\pipe\agenttab-S-1-5-21-123-456-789-1001"
        );
        assert_eq!(
            windows_pipe_sddl(sid).unwrap(),
            "D:P(A;;GA;;;SY)(A;;GA;;;S-1-5-21-123-456-789-1001)"
        );
        for invalid in ["", "S-2-1", "S-1-5;GA;;;WD", "S-1-5\\pipe", " S-1-5 "] {
            assert!(windows_pipe_name(invalid).is_err());
            assert!(windows_pipe_sddl(invalid).is_err());
        }
    }
}

#[cfg(all(unix, test))]
mod unix_probe {
    use super::*;
    use serde_json::json;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
    use tokio::net::{UnixListener, UnixStream};
    use tokio::task::JoinSet;

    fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
        let fd = stream.as_raw_fd();

        #[cfg(any(
            target_os = "macos",
            target_os = "ios",
            target_os = "freebsd",
            target_os = "openbsd",
            target_os = "netbsd",
            target_os = "dragonfly"
        ))]
        {
            let mut uid = 0;
            let mut gid = 0;
            if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(uid)
        }

        #[cfg(target_os = "linux")]
        {
            let mut credentials = libc::ucred {
                pid: 0,
                uid: 0,
                gid: 0,
            };
            let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
            let result = unsafe {
                libc::getsockopt(
                    fd,
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    (&mut credentials as *mut libc::ucred).cast(),
                    &mut length,
                )
            };
            if result != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(credentials.uid)
        }
    }

    fn bind_user_socket(path: &Path, expected_uid: u32) -> Result<UnixListener, ProbeError> {
        let parent = path.parent().ok_or_else(|| {
            ProbeError::InvalidBoundary("socket path has no parent directory".to_owned())
        })?;
        if parent.exists() {
            let metadata = std::fs::symlink_metadata(parent)?;
            if !metadata.is_dir() || metadata.uid() != expected_uid {
                return Err(ProbeError::InvalidBoundary(
                    "socket directory is not owned by the current user".to_owned(),
                ));
            }
        } else {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::set_permissions(
            parent,
            std::fs::Permissions::from_mode(SOCKET_DIRECTORY_MODE),
        )?;

        if path.exists() {
            let metadata = std::fs::symlink_metadata(path)?;
            if !metadata.file_type().is_socket() || metadata.uid() != expected_uid {
                return Err(ProbeError::InvalidBoundary(
                    "refusing to replace a non-socket or foreign-owned IPC path".to_owned(),
                ));
            }
            std::fs::remove_file(path)?;
        }

        let listener = UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(SOCKET_MODE))?;
        let metadata = std::fs::symlink_metadata(path)?;
        if metadata.uid() != expected_uid || metadata.mode() & 0o777 != SOCKET_MODE {
            return Err(ProbeError::InvalidBoundary(
                "socket ownership or permissions are unsafe".to_owned(),
            ));
        }
        Ok(listener)
    }

    async fn serve_two(listener: UnixListener, expected_uid: u32) -> Result<(), ProbeError> {
        let mut handlers = JoinSet::new();
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().await?;
            let actual_uid = peer_uid(&stream)?;
            if actual_uid != expected_uid {
                return Err(ProbeError::PeerDenied {
                    actual: actual_uid,
                    expected: expected_uid,
                });
            }
            handlers.spawn(async move {
                let request = read_frame(&mut stream, CLIENT_TO_HOST_MAX_BYTES)
                    .await?
                    .ok_or_else(|| {
                        ProbeError::InvalidBoundary("peer closed before a request".to_owned())
                    })?;
                write_frame(
                    &mut stream,
                    &json!({"request_id": request["request_id"], "ok": true}),
                    HOST_TO_CLIENT_MAX_BYTES,
                )
                .await
            });
        }
        while let Some(result) = handlers.join_next().await {
            result.map_err(|error| io::Error::other(error.to_string()))??;
        }
        Ok(())
    }

    async fn request(path: &Path, request_id: u64) -> Value {
        let mut stream = UnixStream::connect(path).await.unwrap();
        write_frame(
            &mut stream,
            &json!({"request_id": request_id}),
            CLIENT_TO_HOST_MAX_BYTES,
        )
        .await
        .unwrap();
        read_frame(&mut stream, HOST_TO_CLIENT_MAX_BYTES)
            .await
            .unwrap()
            .unwrap()
    }

    #[test]
    fn socket_path_prefers_only_a_user_owned_runtime_directory() {
        let scratch = tempfile::tempdir().unwrap();
        let uid = unsafe { libc::geteuid() };
        let runtime = scratch.path().join("runtime");
        std::fs::create_dir(&runtime).unwrap();
        assert_eq!(
            unix_socket_path(scratch.path(), Some(&runtime), uid),
            runtime.join("agenttab/agenttab.sock")
        );
        assert_eq!(
            unix_socket_path(scratch.path(), Some(&runtime), uid.wrapping_add(1)),
            scratch.path().join(".agenttab/run/agenttab.sock")
        );
    }

    #[tokio::test]
    async fn socket_is_private_peer_authenticated_and_concurrent() {
        let scratch = tempfile::tempdir().unwrap();
        let uid = unsafe { libc::geteuid() };
        let path = scratch.path().join("run/agenttab.sock");
        let listener = bind_user_socket(&path, uid).unwrap();
        let metadata = std::fs::symlink_metadata(&path).unwrap();
        assert!(metadata.file_type().is_socket());
        assert_eq!(metadata.mode() & 0o777, SOCKET_MODE);
        assert_eq!(
            std::fs::metadata(path.parent().unwrap()).unwrap().mode() & 0o777,
            SOCKET_DIRECTORY_MODE
        );

        let server = tokio::spawn(serve_two(listener, uid));
        let (first, second) = tokio::join!(request(&path, 1), request(&path, 2));
        assert_eq!(first, json!({"request_id": 1, "ok": true}));
        assert_eq!(second, json!({"request_id": 2, "ok": true}));
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn socket_collision_with_regular_file_fails_closed() {
        let scratch = tempfile::tempdir().unwrap();
        let uid = unsafe { libc::geteuid() };
        let path = scratch.path().join("run/agenttab.sock");
        std::fs::create_dir(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"preserve me").unwrap();
        assert!(matches!(
            bind_user_socket(&path, uid).unwrap_err(),
            ProbeError::InvalidBoundary(_)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), b"preserve me");
    }
}

#[cfg(all(windows, test))]
mod windows_probe {
    use super::*;
    use std::ffi::{c_void, OsStr, OsString};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::ptr::null_mut;
    use std::thread;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_BROKEN_PIPE, ERROR_PIPE_BUSY,
        ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_FIRST_PIPE_INSTANCE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, WaitNamedPipeW,
        PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    struct OwnedHandle(HANDLE);

    unsafe impl Send for OwnedHandle {}
    impl OwnedHandle {
        fn raw(&self) -> HANDLE {
            self.0
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn create_pipe(current_user_sid: &str, first: bool) -> Result<OwnedHandle, ProbeError> {
        let sddl = windows_pipe_sddl(current_user_sid)?;
        let mut descriptor: *mut c_void = null_mut();
        let sddl_wide: Vec<u16> = OsStr::new(&sddl).encode_wide().chain(Some(0)).collect();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl_wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error().into());
        }

        let security = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let pipe_name = windows_pipe_name(current_user_sid)?;
        let pipe_wide: Vec<u16> = OsStr::new(&pipe_name)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let handle = unsafe {
            CreateNamedPipeW(
                pipe_wide.as_ptr(),
                PIPE_ACCESS_DUPLEX
                    | if first {
                        FILE_FLAG_FIRST_PIPE_INSTANCE
                    } else {
                        0
                    },
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                2,
                64,
                64,
                0,
                &security,
            )
        };
        unsafe {
            LocalFree(descriptor);
        }
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error().into());
        }
        Ok(OwnedHandle(handle))
    }

    fn connect_server(pipe: HANDLE) -> Result<(), ProbeError> {
        if unsafe { ConnectNamedPipe(pipe, null_mut()) } == 0 {
            let error = unsafe { GetLastError() };
            if error != ERROR_PIPE_CONNECTED {
                return Err(io::Error::from_raw_os_error(error as i32).into());
            }
        }
        Ok(())
    }

    fn connect_client(pipe_name: &str) -> Result<OwnedHandle, ProbeError> {
        let pipe_wide: Vec<u16> = OsStr::new(pipe_name).encode_wide().chain(Some(0)).collect();
        for _ in 0..50 {
            let handle = unsafe {
                CreateFileW(
                    pipe_wide.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    null_mut(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                return Ok(OwnedHandle(handle));
            }
            let error = unsafe { GetLastError() };
            if error != ERROR_PIPE_BUSY {
                return Err(io::Error::from_raw_os_error(error as i32).into());
            }
            unsafe {
                WaitNamedPipeW(pipe_wide.as_ptr(), 50);
            }
        }
        Err(io::Error::new(io::ErrorKind::TimedOut, "named pipe stayed busy").into())
    }

    fn read_exact(pipe: HANDLE, mut buffer: &mut [u8]) -> io::Result<()> {
        while !buffer.is_empty() {
            let mut read = 0;
            if unsafe {
                ReadFile(
                    pipe,
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as u32,
                    &mut read,
                    null_mut(),
                )
            } == 0
            {
                let error = unsafe { GetLastError() };
                if error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "pipe closed"));
                }
                return Err(io::Error::from_raw_os_error(error as i32));
            }
            if read == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "pipe closed"));
            }
            buffer = &mut buffer[read as usize..];
        }
        Ok(())
    }

    fn write_all(pipe: HANDLE, mut buffer: &[u8]) -> io::Result<()> {
        while !buffer.is_empty() {
            let mut written = 0;
            if unsafe {
                WriteFile(
                    pipe,
                    buffer.as_ptr().cast(),
                    buffer.len() as u32,
                    &mut written,
                    null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            if written == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "zero-byte pipe write",
                ));
            }
            buffer = &buffer[written as usize..];
        }
        Ok(())
    }

    fn current_user_sid() -> Result<String, ProbeError> {
        sid_for_process(unsafe { GetCurrentProcess() })
    }

    fn verify_client_sid(pipe: HANDLE, expected_sid: &str) -> Result<(), ProbeError> {
        let mut client_process_id = 0;
        if unsafe { GetNamedPipeClientProcessId(pipe, &mut client_process_id) } == 0 {
            return Err(io::Error::last_os_error().into());
        }
        let process =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, client_process_id) };
        if process.is_null() {
            return Err(io::Error::last_os_error().into());
        }
        let process = OwnedHandle(process);
        if sid_for_process(process.0)? != expected_sid {
            return Err(ProbeError::PipePeerDenied);
        }
        Ok(())
    }

    fn sid_for_process(process: HANDLE) -> Result<String, ProbeError> {
        let mut token = null_mut();
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error().into());
        }
        let token = OwnedHandle(token);
        let mut required = 0;
        unsafe {
            GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut required);
        }
        if required == 0 {
            return Err(io::Error::last_os_error().into());
        }
        let mut token_user = vec![0_u8; required as usize];
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                token_user.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        } == 0
        {
            return Err(io::Error::last_os_error().into());
        }
        let sid = unsafe { (*(token_user.as_ptr().cast::<TOKEN_USER>())).User.Sid };
        let mut sid_text = null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut sid_text) } == 0 {
            return Err(io::Error::last_os_error().into());
        }
        let result = unsafe {
            let length = (0..)
                .find(|offset| *sid_text.add(*offset) == 0)
                .expect("Windows returned a terminated SID string");
            OsString::from_wide(std::slice::from_raw_parts(sid_text, length))
                .to_string_lossy()
                .into_owned()
        };
        unsafe {
            LocalFree(sid_text.cast());
        }
        Ok(result)
    }

    #[test]
    fn named_pipe_is_user_only_peer_authenticated_and_multi_instance() {
        let sid = current_user_sid().unwrap();
        let name = windows_pipe_name(&sid).unwrap();
        let first = create_pipe(&sid, true).unwrap();
        let second = create_pipe(&sid, false).unwrap();

        let servers: Vec<_> = [first, second]
            .into_iter()
            .map(|pipe| {
                let expected_sid = sid.clone();
                thread::spawn(move || {
                    connect_server(pipe.raw()).unwrap();
                    verify_client_sid(pipe.raw(), &expected_sid).unwrap();
                    let mut marker = [0_u8; 1];
                    read_exact(pipe.raw(), &mut marker).unwrap();
                    write_all(pipe.raw(), &[marker[0] + 10]).unwrap();
                })
            })
            .collect();

        let first_client = connect_client(&name).unwrap();
        let second_client = connect_client(&name).unwrap();
        write_all(first_client.0, &[1]).unwrap();
        write_all(second_client.0, &[2]).unwrap();
        let mut first_reply = [0_u8; 1];
        let mut second_reply = [0_u8; 1];
        read_exact(first_client.0, &mut first_reply).unwrap();
        read_exact(second_client.0, &mut second_reply).unwrap();
        let mut replies = [first_reply[0], second_reply[0]];
        replies.sort_unstable();
        assert_eq!(replies, [11, 12]);
        for server in servers {
            server.join().unwrap();
        }
    }
}
