use agenttab_host::{native_relay, AgentTabPaths, HandoffState, Lifecycle, Runtime, StdioNative};
use std::io;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    match std::env::args().nth(1).as_deref() {
        None => run_legacy().await,
        Some("daemon") => run_daemon().await,
        Some(argument) => Err(format!("unknown agenttab-host mode: {argument}").into()),
    }
}

async fn run_legacy() -> Result<(), Box<dyn std::error::Error>> {
    let paths = AgentTabPaths::discover()?;
    let lifecycle = Arc::new(Lifecycle::default());
    let handoff = Arc::new(HandoffState::default());
    let native = StdioNative::new(io::stdout(), lifecycle.clone(), handoff.clone());
    let runtime = Runtime::open(&paths, lifecycle.clone(), native.clone(), handoff)?;

    let (native_done_sender, native_done) = tokio::sync::oneshot::channel();
    let reader_native = native.clone();
    std::thread::Builder::new()
        .name("agenttab-native-reader".into())
        .spawn(move || {
            let stdin = io::stdin();
            let result = reader_native.reader_loop(stdin.lock());
            let _ = native_done_sender.send(result);
        })?;

    #[cfg(unix)]
    tokio::select! {
        result = agenttab_host::server::serve_unix(runtime, paths.socket_file) => result?,
        result = tokio::signal::ctrl_c() => result?,
        result = native_done => result??,
    }
    #[cfg(windows)]
    tokio::select! {
        result = agenttab_host::server::serve_windows(runtime) => result?,
        result = tokio::signal::ctrl_c() => result?,
        result = native_done => result??,
    }
    lifecycle.terminal("host shutdown");
    Ok(())
}

async fn run_daemon() -> Result<(), Box<dyn std::error::Error>> {
    let paths = AgentTabPaths::discover_for_shim(&std::env::current_exe()?)?;
    let lifecycle = Arc::new(Lifecycle::default());
    let handoff = Arc::new(HandoffState::default());
    let native = StdioNative::reconnectable(lifecycle.clone(), handoff.clone());
    let runtime = Runtime::open(&paths, lifecycle.clone(), native.clone(), handoff)?;

    #[cfg(unix)]
    tokio::select! {
        result = agenttab_host::server::serve_unix(runtime, paths.socket_file.clone()) => result?,
        result = native_relay::serve(native, &paths) => result?,
        result = tokio::signal::ctrl_c() => result?,
    }
    #[cfg(windows)]
    tokio::select! {
        result = agenttab_host::server::serve_windows(runtime) => result?,
        result = native_relay::serve(native, &paths) => result?,
        result = tokio::signal::ctrl_c() => result?,
    }
    lifecycle.terminal("daemon shutdown");
    Ok(())
}
