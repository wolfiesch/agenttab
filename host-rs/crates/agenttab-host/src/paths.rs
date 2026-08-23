use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct AgentTabPaths {
    pub root: PathBuf,
    pub state_db: PathBuf,
    pub audit_log: PathBuf,
    pub policy_file: PathBuf,
    pub run_dir: PathBuf,
    pub lock_file: PathBuf,
    #[cfg(unix)]
    pub socket_file: PathBuf,
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

    fn from_root_and_run(root: PathBuf, run_dir: PathBuf) -> Self {
        Self {
            state_db: root.join("state.sqlite3"),
            audit_log: root.join("audit.jsonl"),
            policy_file: root.join("policy.json"),
            lock_file: run_dir.join("host.lock"),
            #[cfg(unix)]
            socket_file: run_dir.join("agenttab.sock"),
            run_dir,
            root,
        }
    }

    pub fn prepare(&self) -> io::Result<()> {
        create_private_directory(&self.root)?;
        create_private_directory(&self.run_dir)?;
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
        assert_eq!(paths.lock_file, paths.run_dir.join("host.lock"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&paths.root).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }
}
