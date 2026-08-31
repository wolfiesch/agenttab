use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstalledRuntimeConfig {
    schema_version: u8,
    state_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct AgentTabPaths {
    pub root: PathBuf,
    pub state_db: PathBuf,
    pub audit_log: PathBuf,
    pub policy_file: PathBuf,
    pub upload_staging_dir: PathBuf,
    pub run_dir: PathBuf,
    pub lock_file: PathBuf,
    #[cfg(unix)]
    pub socket_file: PathBuf,
    #[cfg(unix)]
    pub native_socket_file: PathBuf,
}

impl AgentTabPaths {
    pub fn discover() -> io::Result<Self> {
        let root = if let Some(configured) = env::var_os("AGENTTAB_STATE_DIR") {
            PathBuf::from(configured)
        } else {
            #[cfg(unix)]
            {
                let home = env::var_os("HOME")
                    .map(PathBuf::from)
                    .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is not set"))?;
                home.join(".agenttab")
            }
            #[cfg(windows)]
            {
                let local_app_data =
                    env::var_os("LOCALAPPDATA")
                        .map(PathBuf::from)
                        .ok_or_else(|| {
                            io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA is not set")
                        })?;
                local_app_data.join("AgentTab")
            }
        };

        #[cfg(unix)]
        let run_dir = runtime_directory(&root)?;
        #[cfg(windows)]
        let run_dir = root.join("run");

        Ok(Self::from_root_and_run(root, run_dir))
    }

    pub fn from_root(root: PathBuf) -> Self {
        let run_dir = root.join("run");
        Self::from_root_and_run(root, run_dir)
    }

    pub fn discover_for_shim(shim: &Path) -> io::Result<Self> {
        let config_path = shim
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "shim has no parent"))?
            .join("agenttab-runtime.json");
        let bytes = match fs::read(&config_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Self::discover(),
            Err(error) => return Err(error),
        };
        let config: InstalledRuntimeConfig = serde_json::from_slice(&bytes).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid {}: {error}", config_path.display()),
            )
        })?;
        if config.schema_version != 1 || !config.state_dir.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "installed runtime config must use schemaVersion 1 and an absolute stateDir",
            ));
        }
        #[cfg(unix)]
        let run_dir = runtime_directory(&config.state_dir)?;
        #[cfg(windows)]
        let run_dir = config.state_dir.join("run");
        Ok(Self::from_root_and_run(config.state_dir, run_dir))
    }

    fn from_root_and_run(root: PathBuf, run_dir: PathBuf) -> Self {
        Self {
            state_db: root.join("state.sqlite3"),
            audit_log: root.join("audit.jsonl"),
            policy_file: root.join("policy.json"),
            upload_staging_dir: root.join("upload-staging"),
            lock_file: run_dir.join("host.lock"),
            #[cfg(unix)]
            socket_file: run_dir.join("agenttab.sock"),
            #[cfg(unix)]
            native_socket_file: run_dir.join("agenttab-native.sock"),
            run_dir,
            root,
        }
    }

    pub fn prepare(&self) -> io::Result<()> {
        create_private_directory(&self.root)?;
        create_private_directory(&self.run_dir)?;
        create_private_directory(&self.upload_staging_dir)?;
        Ok(())
    }
}

#[cfg(unix)]
fn runtime_directory(root: &Path) -> io::Result<PathBuf> {
    use std::os::unix::fs::MetadataExt;

    if let Some(candidate) = env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) {
        if let Ok(metadata) = fs::metadata(&candidate) {
            let current_uid = unsafe { libc::geteuid() };
            if metadata.is_dir() && metadata.uid() == current_uid {
                return Ok(candidate.join("agenttab"));
            }
        }
    }
    Ok(root.join("run"))
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

    if !path.exists() {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700).create(path)?;
    }
    let metadata = fs::symlink_metadata(path)?;
    let current_uid = unsafe { libc::geteuid() };
    if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.uid() != current_uid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{} must be a user-owned directory", path.display()),
        ));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn create_private_directory(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_paths_are_stable_and_private() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AgentTabPaths::from_root(temp.path().join("agenttab"));
        paths.prepare().unwrap();
        assert_eq!(paths.state_db, paths.root.join("state.sqlite3"));
        assert_eq!(paths.upload_staging_dir, paths.root.join("upload-staging"));
        assert_eq!(paths.lock_file, paths.run_dir.join("host.lock"));
        #[cfg(unix)]
        assert_eq!(
            paths.native_socket_file,
            paths.run_dir.join("agenttab-native.sock")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&paths.root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&paths.upload_staging_dir)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn installed_shim_config_selects_the_installer_state_root() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("versions/v2/target");
        fs::create_dir_all(&target).unwrap();
        let state = temp.path().join("custom-state");
        fs::write(
            target.join("agenttab-runtime.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "stateDir": state,
            }))
            .unwrap(),
        )
        .unwrap();
        let paths = AgentTabPaths::discover_for_shim(&target.join("agenttab-native")).unwrap();
        assert_eq!(paths.root, temp.path().join("custom-state"));
    }
}
