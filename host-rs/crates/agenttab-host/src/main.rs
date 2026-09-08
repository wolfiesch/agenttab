use agenttab_host::{AgentTabPaths, Lifecycle, Runtime, StdioNative};
use std::io;
use std::sync::Arc;

#[cfg(unix)]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let paths = AgentTabPaths::discover()?;
    let lifecycle = Arc::new(Lifecycle::default());
    let native = StdioNative::new(io::stdout(), lifecycle.clone());
    let runtime = Runtime::open(&paths, lifecycle.clone(), native.clone())?;

    let (native_done_sender, native_done) = tokio::sync::oneshot::channel();
    let reader_native = native.clone();
    std::thread::Builder::new()
        .name("agenttab-native-reader".into())
        .spawn(move || {
            let stdin = io::stdin();
            let result = reader_native.reader_loop(stdin.lock());
            let _ = native_done_sender.send(result);
        })?;

    tokio::select! {
        result = agenttab_host::server::serve_unix(runtime, paths.socket_file) => result?,
        result = tokio::signal::ctrl_c() => result?,
        result = native_done => result??,
    }
    lifecycle.terminal("host shutdown");
    Ok(())
}

#[cfg(windows)]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let paths = AgentTabPaths::discover()?;
    let lifecycle = Arc::new(Lifecycle::default());
    let native = StdioNative::new(io::stdout(), lifecycle.clone());
    let runtime = Runtime::open(&paths, lifecycle.clone(), native.clone())?;

    let (native_done_sender, native_done) = tokio::sync::oneshot::channel();
    let reader_native = native.clone();
    std::thread::Builder::new()
        .name("agenttab-native-reader".into())
        .spawn(move || {
            let stdin = io::stdin();
            let result = reader_native.reader_loop(stdin.lock());
            let _ = native_done_sender.send(result);
        })?;

    tokio::select! {
        result = agenttab_host::server::serve_windows(runtime) => result?,
        result = tokio::signal::ctrl_c() => result?,
        result = native_done => result??,
    }
    lifecycle.terminal("host shutdown");
    Ok(())
}
