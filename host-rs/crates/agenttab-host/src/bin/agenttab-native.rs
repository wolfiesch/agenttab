use agenttab_host::{native_relay, AgentTabPaths};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let shim = std::env::current_exe()?;
    let paths = AgentTabPaths::discover_for_shim(&shim)?;
    native_relay::run_shim(paths, shim).await?;
    Ok(())
}
