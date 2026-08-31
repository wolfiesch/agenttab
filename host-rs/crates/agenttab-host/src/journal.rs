use agenttab_protocol::{
    NativeHandoff, NativeStagedCommit, NativeTab, Outcome, RpcError, RpcMethod, RpcResponse,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use parking_lot::Mutex;
use rand::rngs::OsRng;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use uuid::Uuid;

const IDEMPOTENCY_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const IDEMPOTENCY_FUTURE_SKEW_MS: i64 = 5 * 60 * 1000;
const MAX_RECORDS_PER_TASK: i64 = 10_000;
const CLOSED_TASK_RETENTION_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_STAGE_LIFETIME_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Error)]
pub enum JournalError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("invalid UUID stored in journal: {0}")]
    InvalidUuid(#[from] uuid::Error),
    #[error("invalid cached response: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("idempotency_key has expired")]
    ExpiredKey,
    #[error("idempotency_key timestamp is too far in the future")]
    FutureKey,
    #[error("idempotency_key was already used with different inputs")]
    IdempotencyConflict,
    #[error("task has reached the 10000-request idempotency retention limit")]
    TaskCapacity,
    #[error("idempotency journal entry disappeared before completion")]
    MissingStartedRecord,
    #[error("staged commit token is invalid, expired, used, or belongs to another task")]
    InvalidStagedToken,
    #[error("staged commit expiry must be in the future and no more than five minutes away")]
    InvalidStagedExpiry,
    #[error("resume capability rotation was not pending for this task")]
    ResumeRotationLost,
    #[error("task is closed or missing")]
    MissingTask,
    #[error("tab {tab_id} is not owned by this active task")]
    TabNotOwned { tab_id: u64 },
    #[error("page revision is stale: expected {expected}, current {actual}")]
    StalePageRevision { expected: u64, actual: u64 },
    #[error("staged commit no longer matches current task ownership or page revision")]
    StaleStagedCommit,
    #[error("staged commit is not bound to the task's current tab and page revision")]
    InvalidStagedBinding,
    #[error("page revision cannot be represented by the durable state store")]
    InvalidPageRevision,
    #[error("invalid native inventory: {0}")]
    InvalidInventory(String),
    #[error("handoff event id was reused with different state")]
    HandoffEventConflict,
    #[error("handoff clear event is missing its acknowledgement id")]
    MissingHandoffEventId,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("native task cleanup failed: {0}")]
    NativeTaskCleanup(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InventoryReconciliation {
    Applied,
    IgnoredStale,
}

#[derive(Debug, Clone)]
pub struct TaskLease {
    pub task_id: Uuid,
    pub resume_capability: String,
}

#[derive(Debug)]
pub enum BeginDecision {
    Dispatch,
    Cached(Value),
    Unknown,
}

#[derive(Debug, Clone)]
pub struct StagedRecord {
    pub task_id: Uuid,
    pub native_token: String,
    pub tab_id: u64,
    pub page_revision: u64,
    pub effect: String,
    pub fingerprint: String,
    pub expires_at_ms: i64,
    pub upload_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct StagedCommitHandles {
    pub staged_token: String,
    pub review_handle: String,
}

#[derive(Debug)]
pub enum StagedCommitConsumption {
    Ready(StagedRecord),
    ApprovalRequired,
    Expired(Vec<PathBuf>),
}

#[derive(Debug)]
pub enum StagedCommitApproval {
    Approved,
    Expired(Vec<PathBuf>),
}

#[derive(Debug)]
pub enum StagedReplayResolution {
    Active,
    Unavailable,
    Expired(Vec<PathBuf>),
}

fn staged_commit_terminal_failure(request_id: impl Into<String>) -> RpcResponse {
    RpcResponse::failure(
        request_id,
        Outcome::NotStarted,
        RpcError::new(
            "staged_token_invalid",
            JournalError::InvalidStagedToken.to_string(),
        )
        .with_recovery(
            "Inspect the page, then request and review a new staged operation with a new UUIDv7 idempotency key.",
        ),
    )
}

type StagedCommitRow = (
    String,
    String,
    i64,
    i64,
    String,
    String,
    i64,
    String,
    bool,
    bool,
    Option<String>,
);

#[derive(Debug)]
pub struct Journal {
    connection: Mutex<Connection>,
}

impl Journal {
    pub fn open(path: &Path) -> Result<Self, JournalError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             PRAGMA foreign_keys=ON;
             PRAGMA busy_timeout=5000;
             CREATE TABLE IF NOT EXISTS tasks (
                 task_id TEXT PRIMARY KEY,
                 resume_hash BLOB NOT NULL UNIQUE,
                 pending_resume_hash BLOB,
                 state TEXT NOT NULL CHECK (state IN ('active', 'closed')),
                 conversation_id TEXT,
                 active_connections INTEGER NOT NULL DEFAULT 0 CHECK (active_connections >= 0),
                 tab_count INTEGER NOT NULL DEFAULT 0 CHECK (tab_count >= 0),
                 created_at_ms INTEGER NOT NULL,
                 updated_at_ms INTEGER NOT NULL,
                 closed_at_ms INTEGER
             );
             CREATE TABLE IF NOT EXISTS idempotency_journal (
                 task_id TEXT NOT NULL,
                 idempotency_key TEXT NOT NULL,
                 method TEXT NOT NULL,
                 input_hash TEXT NOT NULL,
                 state TEXT NOT NULL CHECK (state IN ('started', 'completed')),
                 response_json TEXT,
                 created_at_ms INTEGER NOT NULL,
                 completed_at_ms INTEGER,
                 PRIMARY KEY (task_id, idempotency_key),
                 FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_idempotency_retention
                 ON idempotency_journal(task_id, state, completed_at_ms);
             CREATE TABLE IF NOT EXISTS task_tabs (
                 task_id TEXT NOT NULL,
                 tab_id INTEGER NOT NULL,
                 window_id INTEGER NOT NULL,
                 group_id INTEGER NOT NULL,
                 url TEXT NOT NULL,
                 page_revision INTEGER NOT NULL,
                 PRIMARY KEY (task_id, tab_id),
                 UNIQUE (tab_id),
                 FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
             );
             CREATE TABLE IF NOT EXISTS tab_revision_floors (
                 tab_id INTEGER PRIMARY KEY,
                 page_revision INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS handoff_state (
                 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                 active INTEGER NOT NULL CHECK (active IN (0, 1)),
                 task_id TEXT,
                 tab_id INTEGER,
                 started_at_ms INTEGER
             );
             CREATE TABLE IF NOT EXISTS native_event_receipts (
                 event_id TEXT PRIMARY KEY,
                 event_name TEXT NOT NULL,
                 payload_hash BLOB NOT NULL,
                 applied_at_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS staged_commits (
                 token_hash BLOB PRIMARY KEY,
                 review_handle_hash BLOB,
                 task_id TEXT NOT NULL,
                 native_token TEXT NOT NULL,
                 tab_id INTEGER NOT NULL,
                 page_revision INTEGER NOT NULL,
                 effect TEXT NOT NULL,
                 fingerprint TEXT NOT NULL,
                 expires_at_ms INTEGER NOT NULL,
                 approved INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0, 1)),
                 used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1)),
                 consumed_idempotency_key TEXT,
                 upload_paths_json TEXT NOT NULL DEFAULT '[]',
                 FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_staged_commits_native_token
                 ON staged_commits(native_token);
             CREATE UNIQUE INDEX IF NOT EXISTS idx_staged_commits_review_handle
                 ON staged_commits(review_handle_hash);",
        )?;
        ensure_column(
            &connection,
            "tasks",
            "active_connections",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "tasks",
            "tab_count",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(&connection, "tasks", "closed_at_ms", "INTEGER")?;
        ensure_column(&connection, "tasks", "pending_resume_hash", "BLOB")?;
        ensure_column(
            &connection,
            "staged_commits",
            "upload_paths_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column(&connection, "staged_commits", "review_handle_hash", "BLOB")?;
        ensure_column(
            &connection,
            "staged_commits",
            "approved",
            "INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0, 1))",
        )?;
        ensure_column(
            &connection,
            "staged_commits",
            "consumed_idempotency_key",
            "TEXT",
        )?;
        connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_staged_commits_review_handle
             ON staged_commits(review_handle_hash)",
            [],
        )?;
        connection.execute(
            "UPDATE tasks SET active_connections = 0, pending_resume_hash = NULL",
            [],
        )?;
        cleanup_expired_tasks(&connection, now_ms())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn create_task(&self, conversation_id: Option<&str>) -> Result<TaskLease, JournalError> {
        let task_id = Uuid::now_v7();
        let resume_capability = generate_capability();
        let resume_hash = capability_hash(&resume_capability);
        let now = now_ms();
        let connection = self.connection.lock();
        connection.execute(
            "INSERT INTO tasks(
                 task_id, resume_hash, state, conversation_id, active_connections,
                 created_at_ms, updated_at_ms
             ) VALUES (?1, ?2, 'active', ?3, 1, ?4, ?4)",
            params![
                task_id.to_string(),
                resume_hash.as_slice(),
                conversation_id,
                now
            ],
        )?;
        Ok(TaskLease {
            task_id,
            resume_capability,
        })
    }

    pub fn resume_task(&self, capability: &str) -> Result<Option<TaskLease>, JournalError> {
        let old_hash = capability_hash(capability);
        let next_capability = generate_capability();
        let next_hash = capability_hash(&next_capability);
        let now = now_ms();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task_id: Option<String> = transaction
            .query_row(
                "SELECT task_id FROM tasks
                 WHERE resume_hash = ?1 AND pending_resume_hash IS NULL AND state = 'active'",
                params![old_hash.as_slice()],
                |row| row.get(0),
            )
            .optional()?;
        let Some(task_id) = task_id else {
            transaction.rollback()?;
            return Ok(None);
        };
        let updated = transaction.execute(
            "UPDATE tasks
             SET pending_resume_hash = ?1,
                 active_connections = active_connections + 1,
                 updated_at_ms = ?2
             WHERE task_id = ?3
               AND resume_hash = ?4
               AND pending_resume_hash IS NULL
               AND state = 'active'",
            params![next_hash.as_slice(), now, task_id, old_hash.as_slice(),],
        )?;
        if updated != 1 {
            transaction.rollback()?;
            return Err(JournalError::ResumeRotationLost);
        }
        transaction.commit()?;
        Ok(Some(TaskLease {
            task_id: Uuid::parse_str(&task_id)?,
            resume_capability: next_capability,
        }))
    }

    pub fn acknowledge_resume_capability(
        &self,
        task_id: Uuid,
        capability: &str,
    ) -> Result<(), JournalError> {
        let capability_hash = capability_hash(capability);
        let connection = self.connection.lock();
        let updated = connection.execute(
            "UPDATE tasks
             SET resume_hash = pending_resume_hash,
                 pending_resume_hash = NULL,
                 updated_at_ms = ?1
             WHERE task_id = ?2 AND pending_resume_hash = ?3 AND state = 'active'",
            params![now_ms(), task_id.to_string(), capability_hash.as_slice()],
        )?;
        if updated != 1 {
            return Err(JournalError::ResumeRotationLost);
        }
        Ok(())
    }

    pub fn rollback_resume_capability(
        &self,
        task_id: Uuid,
        capability: &str,
    ) -> Result<(), JournalError> {
        let capability_hash = capability_hash(capability);
        let connection = self.connection.lock();
        let updated = connection.execute(
            "UPDATE tasks
             SET pending_resume_hash = NULL, updated_at_ms = ?1
             WHERE task_id = ?2 AND pending_resume_hash = ?3 AND state = 'active'",
            params![now_ms(), task_id.to_string(), capability_hash.as_slice()],
        )?;
        if updated != 1 {
            return Err(JournalError::ResumeRotationLost);
        }
        Ok(())
    }

    pub fn detach_connection(&self, task_id: Uuid) -> Result<(), JournalError> {
        let now = now_ms();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "UPDATE tasks
             SET active_connections = MAX(active_connections - 1, 0), updated_at_ms = ?1
             WHERE task_id = ?2 AND state = 'active'",
            params![now, task_id.to_string()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn reconcile_inventory(
        &self,
        inventory: &[NativeTab],
    ) -> Result<InventoryReconciliation, JournalError> {
        let now = now_ms();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut seen_tabs = std::collections::HashSet::with_capacity(inventory.len());
        let mut owned = Vec::new();
        let mut counts = std::collections::HashMap::<Uuid, u64>::new();

        for tab in inventory {
            let Some(task_id) = tab.task_id else {
                continue;
            };
            let group_id = tab.group_id.unwrap_or(-1);
            if tab.tab_id == 0 || tab.window_id == 0 || tab.url.is_empty() {
                return Err(JournalError::InvalidInventory(
                    "task-owned tab lacks a valid tab, window, or URL".into(),
                ));
            }
            if !seen_tabs.insert(tab.tab_id) {
                return Err(JournalError::InvalidInventory(
                    "native inventory contains duplicate tab ids".into(),
                ));
            }
            let tab_id = sqlite_u64(tab.tab_id)?;
            let page_revision = sqlite_u64(tab.page_revision)?;
            let active: Option<i64> = transaction
                .query_row(
                    "SELECT 1 FROM tasks WHERE task_id = ?1 AND state = 'active'",
                    params![task_id.to_string()],
                    |row| row.get(0),
                )
                .optional()?;
            if active.is_none() {
                return Err(JournalError::MissingTask);
            }
            let floor: Option<i64> = transaction
                .query_row(
                    "SELECT page_revision FROM tab_revision_floors WHERE tab_id = ?1",
                    params![tab_id],
                    |row| row.get(0),
                )
                .optional()?;
            if floor.is_some_and(|floor| page_revision < floor) {
                // Inventory is an authoritative full snapshot. Ignore all of an older
                // snapshot rather than partially applying ownership or URL regressions.
                return Ok(InventoryReconciliation::IgnoredStale);
            }
            *counts.entry(task_id).or_insert(0) += 1;
            owned.push((
                task_id,
                tab_id,
                sqlite_u64(tab.window_id)?,
                group_id,
                &tab.url,
                page_revision,
            ));
        }

        transaction.execute(
            "DELETE FROM task_tabs
             WHERE task_id IN (SELECT task_id FROM tasks WHERE state = 'active')",
            [],
        )?;
        transaction.execute("UPDATE tasks SET tab_count = 0 WHERE state = 'active'", [])?;
        for (task_id, tab_id, window_id, group_id, url, page_revision) in owned {
            transaction.execute(
                "INSERT INTO tab_revision_floors(tab_id, page_revision)
                 VALUES (?1, ?2)
                 ON CONFLICT(tab_id) DO UPDATE
                 SET page_revision = MAX(tab_revision_floors.page_revision, excluded.page_revision)",
                params![tab_id, page_revision],
            )?;
            transaction.execute(
                "INSERT INTO task_tabs(task_id, tab_id, window_id, group_id, url, page_revision)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    task_id.to_string(),
                    tab_id,
                    window_id,
                    group_id,
                    url,
                    page_revision
                ],
            )?;
        }
        for (task_id, tab_count) in counts {
            transaction.execute(
                "UPDATE tasks SET tab_count = ?1, updated_at_ms = ?2
                 WHERE task_id = ?3 AND state = 'active'",
                params![sqlite_u64(tab_count)?, now, task_id.to_string()],
            )?;
        }
        transaction.commit()?;
        Ok(InventoryReconciliation::Applied)
    }

    pub fn update_task_tab_count(&self, task_id: Uuid, tab_count: u64) -> Result<(), JournalError> {
        let connection = self.connection.lock();
        let updated = connection.execute(
            "UPDATE tasks SET tab_count = ?1, updated_at_ms = ?2
             WHERE task_id = ?3 AND state = 'active'",
            params![sqlite_u64(tab_count)?, now_ms(), task_id.to_string()],
        )?;
        if updated != 1 {
            return Err(JournalError::MissingTask);
        }
        Ok(())
    }

    pub fn verify_task_tab(
        &self,
        task_id: Uuid,
        tab_id: u64,
        expected_page_revision: Option<u64>,
    ) -> Result<u64, JournalError> {
        let connection = self.connection.lock();
        let actual: Option<i64> = connection
            .query_row(
                "SELECT task_tabs.page_revision
                 FROM task_tabs JOIN tasks USING(task_id)
                 WHERE task_tabs.task_id = ?1 AND task_tabs.tab_id = ?2
                   AND tasks.state = 'active'",
                params![task_id.to_string(), sqlite_u64(tab_id)?],
                |row| row.get(0),
            )
            .optional()?;
        let Some(actual) = actual else {
            return Err(JournalError::TabNotOwned { tab_id });
        };
        let actual = actual as u64;
        if expected_page_revision.is_some_and(|expected| expected != actual) {
            return Err(JournalError::StalePageRevision {
                expected: expected_page_revision.expect("checked"),
                actual,
            });
        }
        Ok(actual)
    }

    pub fn close_task(&self, task_id: Uuid) -> Result<(), JournalError> {
        let now = now_ms();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM task_tabs WHERE task_id = ?1",
            params![task_id.to_string()],
        )?;
        transaction.execute(
            "UPDATE tasks
             SET state = 'closed', tab_count = 0, updated_at_ms = ?1,
                 closed_at_ms = COALESCE(closed_at_ms, ?1)
             WHERE task_id = ?2",
            params![now, task_id.to_string()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn lookup_mutation(
        &self,
        task_id: Uuid,
        key: Uuid,
        method: RpcMethod,
        input_hash: &str,
    ) -> Result<Option<BeginDecision>, JournalError> {
        validate_key_timestamp(key)?;
        let connection = self.connection.lock();
        mutation_decision(&connection, task_id, key, method, input_hash)
    }

    pub fn begin_mutation(
        &self,
        task_id: Uuid,
        key: Uuid,
        method: RpcMethod,
        input_hash: &str,
    ) -> Result<BeginDecision, JournalError> {
        validate_key_timestamp(key)?;
        let now = now_ms();
        let mut connection = self.connection.lock();
        cleanup_expired_tasks(&connection, now)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM idempotency_journal
             WHERE task_id = ?1 AND state = 'completed'
               AND completed_at_ms IS NOT NULL AND completed_at_ms < ?2",
            params![task_id.to_string(), now - IDEMPOTENCY_RETENTION_MS],
        )?;

        if let Some(decision) = mutation_decision(&transaction, task_id, key, method, input_hash)? {
            transaction.rollback()?;
            return Ok(decision);
        }

        let count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM idempotency_journal WHERE task_id = ?1",
            params![task_id.to_string()],
            |row| row.get(0),
        )?;
        if count >= MAX_RECORDS_PER_TASK {
            transaction.rollback()?;
            return Err(JournalError::TaskCapacity);
        }
        transaction.execute(
            "INSERT INTO idempotency_journal(
                 task_id, idempotency_key, method, input_hash, state, created_at_ms
             ) VALUES (?1, ?2, ?3, ?4, 'started', ?5)",
            params![
                task_id.to_string(),
                key.to_string(),
                method.to_string(),
                input_hash,
                now
            ],
        )?;
        transaction.commit()?;
        Ok(BeginDecision::Dispatch)
    }

    pub fn complete_mutation(
        &self,
        task_id: Uuid,
        key: Uuid,
        response: &Value,
    ) -> Result<(), JournalError> {
        let encoded = serde_json::to_string(response)?;
        let connection = self.connection.lock();
        let updated = connection.execute(
            "UPDATE idempotency_journal
             SET state = 'completed', response_json = ?1, completed_at_ms = ?2
             WHERE task_id = ?3 AND idempotency_key = ?4 AND state = 'started'",
            params![encoded, now_ms(), task_id.to_string(), key.to_string()],
        )?;
        if updated != 1 {
            return Err(JournalError::MissingStartedRecord);
        }
        Ok(())
    }

    pub fn store_staged_commit(
        &self,
        staged: &NativeStagedCommit,
        upload_paths: &[PathBuf],
    ) -> Result<StagedCommitHandles, JournalError> {
        let now = now_ms();
        if staged.expires_at_ms <= now
            || staged.expires_at_ms > now.saturating_add(MAX_STAGE_LIFETIME_MS)
        {
            return Err(JournalError::InvalidStagedExpiry);
        }
        let staged_token = generate_capability();
        let review_handle = generate_capability();
        let token_hash = capability_hash(&staged_token);
        let review_handle_hash = capability_hash(&review_handle);
        let page_revision = sqlite_u64(staged.page_revision)?;
        let tab_id = sqlite_u64(staged.tab_id)?;
        let upload_paths_json = serde_json::to_string(upload_paths)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current_revision: Option<i64> = transaction
            .query_row(
                "SELECT task_tabs.page_revision
                 FROM task_tabs JOIN tasks USING(task_id)
                 WHERE task_tabs.task_id = ?1 AND task_tabs.tab_id = ?2
                   AND tasks.state = 'active'",
                params![staged.task_id.to_string(), tab_id],
                |row| row.get(0),
            )
            .optional()?;
        if current_revision != Some(page_revision) {
            return Err(JournalError::InvalidStagedBinding);
        }
        transaction.execute(
            "INSERT INTO staged_commits(
                 token_hash, review_handle_hash, task_id, native_token, tab_id, page_revision,
                 effect, fingerprint, expires_at_ms, approved, used, upload_paths_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, ?10)",
            params![
                token_hash.as_slice(),
                review_handle_hash.as_slice(),
                staged.task_id.to_string(),
                staged.native_token,
                tab_id,
                page_revision,
                staged.effect,
                staged.fingerprint,
                staged.expires_at_ms,
                upload_paths_json,
            ],
        )?;
        transaction.commit()?;
        Ok(StagedCommitHandles {
            staged_token,
            review_handle,
        })
    }

    pub fn consume_staged_commit(
        &self,
        task_id: Uuid,
        host_token: &str,
        idempotency_key: Uuid,
    ) -> Result<StagedCommitConsumption, JournalError> {
        let now = now_ms();
        let token_hash = capability_hash(host_token);
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let record: Option<StagedCommitRow> = transaction
            .query_row(
                "SELECT task_id, native_token, tab_id, page_revision, effect, fingerprint,
                        expires_at_ms, upload_paths_json, approved, used, consumed_idempotency_key
                 FROM staged_commits
                 WHERE token_hash = ?1 AND task_id = ?2",
                params![token_hash.as_slice(), task_id.to_string()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            stored_task,
            native_token,
            tab_id,
            page_revision,
            effect,
            fingerprint,
            expires_at_ms,
            upload_paths_json,
            approved,
            used,
            consumed_idempotency_key,
        )) = record
        else {
            transaction.rollback()?;
            return Err(JournalError::InvalidStagedToken);
        };
        if expires_at_ms <= now {
            let terminal_response = serde_json::to_string(
                &staged_commit_terminal_failure("expired-staged-consumption").value(),
            )?;
            if let Some(consumed_idempotency_key) = consumed_idempotency_key {
                let consumed_idempotency_key = Uuid::parse_str(&consumed_idempotency_key)?;
                if consumed_idempotency_key != idempotency_key {
                    self.replace_terminal_mutation(
                        &transaction,
                        task_id,
                        consumed_idempotency_key,
                        &terminal_response,
                    )?;
                }
            }
            self.replace_terminal_mutation(
                &transaction,
                task_id,
                idempotency_key,
                &terminal_response,
            )?;
            if transaction.execute(
                "DELETE FROM staged_commits
                 WHERE token_hash = ?1 AND task_id = ?2 AND expires_at_ms <= ?3",
                params![token_hash.as_slice(), task_id.to_string(), now],
            )? != 1
            {
                transaction.rollback()?;
                return Err(JournalError::InvalidStagedToken);
            }
            transaction.commit()?;
            return Ok(StagedCommitConsumption::Expired(serde_json::from_str(
                &upload_paths_json,
            )?));
        }
        if used {
            transaction.rollback()?;
            return Err(JournalError::InvalidStagedToken);
        }
        if !approved {
            transaction.rollback()?;
            return Ok(StagedCommitConsumption::ApprovalRequired);
        }
        let current_revision: Option<i64> = transaction
            .query_row(
                "SELECT task_tabs.page_revision
                 FROM task_tabs JOIN tasks USING(task_id)
                 WHERE task_tabs.task_id = ?1 AND task_tabs.tab_id = ?2
                   AND tasks.state = 'active'",
                params![task_id.to_string(), tab_id],
                |row| row.get(0),
            )
            .optional()?;
        if current_revision != Some(page_revision) {
            transaction.rollback()?;
            return Err(JournalError::StaleStagedCommit);
        }
        if transaction.execute(
            "UPDATE staged_commits
             SET used = 1, consumed_idempotency_key = ?1
             WHERE token_hash = ?2 AND task_id = ?3 AND approved = 1
               AND used = 0 AND expires_at_ms > ?4",
            params![
                idempotency_key.to_string(),
                token_hash.as_slice(),
                task_id.to_string(),
                now,
            ],
        )? != 1
        {
            transaction.rollback()?;
            return Err(JournalError::InvalidStagedToken);
        }
        transaction.commit()?;
        Ok(StagedCommitConsumption::Ready(StagedRecord {
            task_id: Uuid::parse_str(&stored_task)?,
            native_token,
            tab_id: sqlite_to_u64(tab_id)?,
            page_revision: sqlite_to_u64(page_revision)?,
            effect,
            fingerprint,
            expires_at_ms,
            upload_paths: serde_json::from_str(&upload_paths_json)?,
        }))
    }

    pub fn staged_commit_tab_id(
        &self,
        task_id: Uuid,
        host_token: &str,
    ) -> Result<Option<u64>, JournalError> {
        let token_hash = capability_hash(host_token);
        let connection = self.connection.lock();
        let tab_id: Option<i64> = connection
            .query_row(
                "SELECT tab_id FROM staged_commits
                 WHERE token_hash = ?1 AND task_id = ?2",
                params![token_hash.as_slice(), task_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        tab_id.map(sqlite_to_u64).transpose()
    }

    pub fn approve_popup_staged_commit(
        &self,
        task_id: Uuid,
        tab_id: u64,
        review_handle: &str,
    ) -> Result<StagedCommitApproval, JournalError> {
        let now = now_ms();
        let review_handle_hash = capability_hash(review_handle);
        let expected_tab_id = sqlite_u64(tab_id)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let record: Option<(i64, i64, i64, bool, String)> = transaction
            .query_row(
                "SELECT tab_id, page_revision, expires_at_ms, used, upload_paths_json
                 FROM staged_commits
                 WHERE review_handle_hash = ?1 AND task_id = ?2",
                params![review_handle_hash.as_slice(), task_id.to_string()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((stored_tab_id, page_revision, expires_at_ms, used, upload_paths_json)) = record
        else {
            transaction.rollback()?;
            return Err(JournalError::InvalidStagedToken);
        };
        if stored_tab_id != expected_tab_id || used {
            transaction.rollback()?;
            return Err(JournalError::InvalidStagedToken);
        }
        if expires_at_ms <= now {
            if transaction.execute(
                "DELETE FROM staged_commits
                 WHERE review_handle_hash = ?1 AND task_id = ?2 AND expires_at_ms <= ?3",
                params![review_handle_hash.as_slice(), task_id.to_string(), now],
            )? != 1
            {
                transaction.rollback()?;
                return Err(JournalError::InvalidStagedToken);
            }
            transaction.commit()?;
            return Ok(StagedCommitApproval::Expired(serde_json::from_str(
                &upload_paths_json,
            )?));
        }
        let current_revision: Option<i64> = transaction
            .query_row(
                "SELECT task_tabs.page_revision
                 FROM task_tabs JOIN tasks USING(task_id)
                 WHERE task_tabs.task_id = ?1 AND task_tabs.tab_id = ?2
                   AND tasks.state = 'active'",
                params![task_id.to_string(), stored_tab_id],
                |row| row.get(0),
            )
            .optional()?;
        if current_revision != Some(page_revision) {
            transaction.rollback()?;
            return Err(JournalError::StaleStagedCommit);
        }
        if transaction.execute(
            "UPDATE staged_commits
             SET approved = 1
             WHERE review_handle_hash = ?1 AND task_id = ?2
               AND used = 0 AND expires_at_ms > ?3",
            params![review_handle_hash.as_slice(), task_id.to_string(), now],
        )? != 1
        {
            transaction.rollback()?;
            return Err(JournalError::InvalidStagedToken);
        }
        transaction.commit()?;
        Ok(StagedCommitApproval::Approved)
    }

    pub fn resolve_staged_commit_replay(
        &self,
        task_id: Uuid,
        staged_token: &str,
        idempotency_key: Uuid,
        terminal_response: &Value,
        terminalize_unavailable: bool,
    ) -> Result<StagedReplayResolution, JournalError> {
        self.resolve_staged_commit_replay_by_hash(
            task_id,
            capability_hash(staged_token),
            "token_hash",
            None,
            idempotency_key,
            terminal_response,
            terminalize_unavailable,
        )
    }

    fn resolve_staged_commit_replay_by_hash(
        &self,
        task_id: Uuid,
        capability_hash_value: [u8; 32],
        key_column: &str,
        expected_tab_id: Option<u64>,
        idempotency_key: Uuid,
        terminal_response: &Value,
        terminalize_unavailable: bool,
    ) -> Result<StagedReplayResolution, JournalError> {
        let now = now_ms();
        let encoded_response = serde_json::to_string(terminal_response)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let query = format!(
            "SELECT tab_id, expires_at_ms, used, upload_paths_json, consumed_idempotency_key
             FROM staged_commits
             WHERE {key_column} = ?1 AND task_id = ?2"
        );
        let record: Option<(i64, i64, bool, String, Option<String>)> = transaction
            .query_row(
                &query,
                params![capability_hash_value.as_slice(), task_id.to_string()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        if let Some((tab_id, expires_at_ms, used, upload_paths_json, consumed_idempotency_key)) =
            record
        {
            if expected_tab_id.is_some_and(|expected| sqlite_u64(expected).ok() != Some(tab_id)) {
                transaction.rollback()?;
                return Ok(StagedReplayResolution::Unavailable);
            }
            if expires_at_ms <= now {
                if let Some(consumed_idempotency_key) = consumed_idempotency_key {
                    let consumed_idempotency_key = Uuid::parse_str(&consumed_idempotency_key)?;
                    if consumed_idempotency_key != idempotency_key {
                        self.replace_terminal_mutation(
                            &transaction,
                            task_id,
                            consumed_idempotency_key,
                            &encoded_response,
                        )?;
                    }
                }
                self.replace_terminal_mutation(
                    &transaction,
                    task_id,
                    idempotency_key,
                    &encoded_response,
                )?;
                let delete = format!(
                    "DELETE FROM staged_commits
                     WHERE {key_column} = ?1 AND task_id = ?2 AND expires_at_ms <= ?3"
                );
                if transaction.execute(
                    &delete,
                    params![capability_hash_value.as_slice(), task_id.to_string(), now],
                )? != 1
                {
                    transaction.rollback()?;
                    return Err(JournalError::InvalidStagedToken);
                }
                transaction.commit()?;
                return Ok(StagedReplayResolution::Expired(serde_json::from_str(
                    &upload_paths_json,
                )?));
            }
            if !used {
                transaction.rollback()?;
                return Ok(StagedReplayResolution::Active);
            }
        }
        if terminalize_unavailable {
            self.replace_terminal_mutation(
                &transaction,
                task_id,
                idempotency_key,
                &encoded_response,
            )?;
        }
        transaction.commit()?;
        Ok(StagedReplayResolution::Unavailable)
    }

    fn replace_terminal_mutation(
        &self,
        transaction: &rusqlite::Transaction<'_>,
        task_id: Uuid,
        idempotency_key: Uuid,
        encoded_response: &str,
    ) -> Result<(), JournalError> {
        if transaction.execute(
            "UPDATE idempotency_journal
             SET state = 'completed', response_json = ?1, completed_at_ms = ?2
             WHERE task_id = ?3 AND idempotency_key = ?4",
            params![
                encoded_response,
                now_ms(),
                task_id.to_string(),
                idempotency_key.to_string(),
            ],
        )? != 1
        {
            return Err(JournalError::MissingStartedRecord);
        }
        Ok(())
    }

    pub fn finish_staged_commit(&self, native_token: &str) -> Result<(), JournalError> {
        let connection = self.connection.lock();
        connection.execute(
            "DELETE FROM staged_commits WHERE native_token = ?1",
            params![native_token],
        )?;
        Ok(())
    }

    pub fn abandon_popup_staged_commit(
        &self,
        task_id: Uuid,
        tab_id: u64,
        review_handle: &str,
    ) -> Result<Vec<PathBuf>, JournalError> {
        let review_hash = capability_hash(review_handle);
        let tab_id = sqlite_u64(tab_id)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let upload_paths_json: Option<String> = transaction
            .query_row(
                "SELECT upload_paths_json FROM staged_commits
                 WHERE review_handle_hash = ?1 AND task_id = ?2 AND tab_id = ?3 AND used = 0",
                params![review_hash.as_slice(), task_id.to_string(), tab_id],
                |row| row.get(0),
            )
            .optional()?;
        if upload_paths_json.is_none() {
            transaction.rollback()?;
            return Err(JournalError::InvalidStagedToken);
        }
        transaction.execute(
            "DELETE FROM staged_commits WHERE review_handle_hash = ?1",
            params![review_hash.as_slice()],
        )?;
        transaction.commit()?;
        Ok(serde_json::from_str(
            upload_paths_json.as_deref().unwrap_or("[]"),
        )?)
    }

    pub fn abandon_all_staged_commits(&self) -> Result<Vec<PathBuf>, JournalError> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let rows = {
            let mut statement = transaction
                .prepare("SELECT upload_paths_json FROM staged_commits WHERE used = 0")?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        transaction.execute("DELETE FROM staged_commits WHERE used = 0", [])?;
        transaction.commit()?;
        let mut upload_paths = Vec::new();
        for paths in rows {
            upload_paths.extend(serde_json::from_str::<Vec<PathBuf>>(&paths)?);
        }
        Ok(upload_paths)
    }

    pub fn reconcile_staged_commits(
        &self,
        staged_commits: &[NativeStagedCommit],
    ) -> Result<Vec<PathBuf>, JournalError> {
        let now = now_ms();
        let active_tokens = staged_commits
            .iter()
            .filter(|staged| staged.expires_at_ms > now)
            .map(|staged| staged.native_token.as_str())
            .collect::<std::collections::HashSet<_>>();
        let terminal_response = serde_json::to_string(
            &staged_commit_terminal_failure("recovered-staged-expiry").value(),
        )?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let persisted = {
            let mut statement = transaction.prepare(
                "SELECT native_token, upload_paths_json, expires_at_ms, used, task_id,
                        consumed_idempotency_key
                 FROM staged_commits",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, bool>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut removed_uploads = Vec::new();
        for (
            native_token,
            upload_paths_json,
            expires_at_ms,
            used,
            task_id,
            consumed_idempotency_key,
        ) in persisted
        {
            if expires_at_ms <= now {
                if let Some(consumed_idempotency_key) = consumed_idempotency_key {
                    self.replace_terminal_mutation(
                        &transaction,
                        Uuid::parse_str(&task_id)?,
                        Uuid::parse_str(&consumed_idempotency_key)?,
                        &terminal_response,
                    )?;
                }
                removed_uploads.extend(serde_json::from_str::<Vec<PathBuf>>(&upload_paths_json)?);
                transaction.execute(
                    "DELETE FROM staged_commits WHERE native_token = ?1",
                    params![native_token],
                )?;
            } else if !used && !active_tokens.contains(native_token.as_str()) {
                removed_uploads.extend(serde_json::from_str::<Vec<PathBuf>>(&upload_paths_json)?);
                transaction.execute(
                    "DELETE FROM staged_commits WHERE native_token = ?1",
                    params![native_token],
                )?;
            }
        }
        transaction.commit()?;
        Ok(removed_uploads)
    }

    pub fn expire_staged_commit(&self, native_token: &str) -> Result<Vec<PathBuf>, JournalError> {
        let terminal_response = serde_json::to_string(
            &staged_commit_terminal_failure("expired-staged-commit").value(),
        )?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let record: Option<(String, Option<String>, String)> = transaction
            .query_row(
                "SELECT task_id, consumed_idempotency_key, upload_paths_json
                 FROM staged_commits WHERE native_token = ?1",
                params![native_token],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((task_id, consumed_idempotency_key, upload_paths_json)) = record else {
            transaction.rollback()?;
            return Ok(Vec::new());
        };
        if let Some(consumed_idempotency_key) = consumed_idempotency_key {
            self.replace_terminal_mutation(
                &transaction,
                Uuid::parse_str(&task_id)?,
                Uuid::parse_str(&consumed_idempotency_key)?,
                &terminal_response,
            )?;
        }
        transaction.execute(
            "DELETE FROM staged_commits WHERE native_token = ?1",
            params![native_token],
        )?;
        transaction.commit()?;
        Ok(serde_json::from_str(&upload_paths_json)?)
    }
    pub fn reconcile_handoff(&self, handoff: &NativeHandoff) -> Result<(), JournalError> {
        self.store_handoff(handoff, None, false)
    }

    pub fn apply_handoff_event(
        &self,
        handoff: &NativeHandoff,
        event_id: Option<&str>,
    ) -> Result<(), JournalError> {
        self.store_handoff(handoff, event_id, true)
    }

    fn store_handoff(
        &self,
        handoff: &NativeHandoff,
        event_id: Option<&str>,
        receipt_required: bool,
    ) -> Result<(), JournalError> {
        if receipt_required && !handoff.active && event_id.is_none() {
            return Err(JournalError::MissingHandoffEventId);
        }
        let payload_hash = handoff_payload_hash(handoff);
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(event_id) = event_id {
            let previous: Option<Vec<u8>> = transaction
                .query_row(
                    "SELECT payload_hash FROM native_event_receipts
                     WHERE event_id = ?1 AND event_name = 'handoff_changed'",
                    params![event_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(previous) = previous {
                if previous.as_slice() != payload_hash.as_slice() {
                    return Err(JournalError::HandoffEventConflict);
                }
                transaction.commit()?;
                return Ok(());
            }
        }
        transaction.execute(
            "INSERT INTO handoff_state(singleton, active, task_id, tab_id, started_at_ms)
             VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT(singleton) DO UPDATE SET
                 active = excluded.active,
                 task_id = excluded.task_id,
                 tab_id = excluded.tab_id,
                 started_at_ms = excluded.started_at_ms",
            params![
                if handoff.active { 1_i64 } else { 0_i64 },
                handoff.task_id.map(|task_id| task_id.to_string()),
                handoff.tab_id.map(sqlite_u64).transpose()?,
                handoff.started_at_ms,
            ],
        )?;
        if let Some(event_id) = event_id {
            transaction.execute(
                "INSERT INTO native_event_receipts(event_id, event_name, payload_hash, applied_at_ms)
                 VALUES (?1, 'handoff_changed', ?2, ?3)",
                params![event_id, payload_hash.as_slice(), now_ms()],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn handoff_active(&self) -> Result<bool, JournalError> {
        Ok(self.handoff_binding()?.is_some())
    }

    pub fn handoff_binding(&self) -> Result<Option<(Uuid, u64)>, JournalError> {
        let connection = self.connection.lock();
        let binding: Option<(i64, Option<String>, Option<i64>)> = connection
            .query_row(
                "SELECT active, task_id, tab_id FROM handoff_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        match binding {
            Some((1, Some(task_id), Some(tab_id))) => {
                Ok(Some((Uuid::parse_str(&task_id)?, sqlite_to_u64(tab_id)?)))
            }
            _ => Ok(None),
        }
    }
}

fn mutation_decision(
    connection: &Connection,
    task_id: Uuid,
    key: Uuid,
    method: RpcMethod,
    input_hash: &str,
) -> Result<Option<BeginDecision>, JournalError> {
    let existing: Option<(String, String, String, Option<String>)> = connection
        .query_row(
            "SELECT method, input_hash, state, response_json
             FROM idempotency_journal
             WHERE task_id = ?1 AND idempotency_key = ?2",
            params![task_id.to_string(), key.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((stored_method, stored_hash, state, response_json)) = existing else {
        return Ok(None);
    };
    if stored_method != method.to_string() || stored_hash != input_hash {
        return Err(JournalError::IdempotencyConflict);
    }
    if state == "completed" {
        return Ok(Some(BeginDecision::Cached(serde_json::from_str(
            response_json
                .as_deref()
                .ok_or(JournalError::MissingStartedRecord)?,
        )?)));
    }
    Ok(Some(BeginDecision::Unknown))
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> Result<(), JournalError> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !columns.iter().any(|existing| existing == column) {
        connection.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {declaration}"
        ))?;
    }
    Ok(())
}

fn cleanup_expired_tasks(connection: &Connection, now: i64) -> Result<(), JournalError> {
    connection.execute(
        "DELETE FROM tasks
         WHERE state = 'closed' AND closed_at_ms IS NOT NULL AND closed_at_ms < ?1",
        params![now - CLOSED_TASK_RETENTION_MS],
    )?;
    Ok(())
}

fn generate_capability() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn capability_hash(capability: &str) -> [u8; 32] {
    Sha256::digest(capability.as_bytes()).into()
}

fn handoff_payload_hash(handoff: &NativeHandoff) -> [u8; 32] {
    let task_id = handoff.task_id.map(|task_id| task_id.to_string());
    let tab_id = handoff.tab_id.map(|tab_id| tab_id.to_string());
    Sha256::digest(
        format!(
            "{}\u{1f}{}\u{1f}{}\u{1f}{}",
            handoff.active,
            task_id.as_deref().unwrap_or_default(),
            tab_id.as_deref().unwrap_or_default(),
            handoff.started_at_ms.unwrap_or_default(),
        )
        .as_bytes(),
    )
    .into()
}
fn sqlite_u64(value: u64) -> Result<i64, JournalError> {
    i64::try_from(value).map_err(|_| JournalError::InvalidPageRevision)
}

fn sqlite_to_u64(value: i64) -> Result<u64, JournalError> {
    u64::try_from(value).map_err(|_| JournalError::InvalidPageRevision)
}

fn validate_key_timestamp(key: Uuid) -> Result<(), JournalError> {
    let timestamp = uuid_v7_timestamp_ms(key);
    let now = now_ms();
    if timestamp < now - IDEMPOTENCY_RETENTION_MS {
        return Err(JournalError::ExpiredKey);
    }
    if timestamp > now + IDEMPOTENCY_FUTURE_SKEW_MS {
        return Err(JournalError::FutureKey);
    }
    Ok(())
}

fn uuid_v7_timestamp_ms(key: Uuid) -> i64 {
    let bytes = key.as_bytes();
    ((bytes[0] as i64) << 40)
        | ((bytes[1] as i64) << 32)
        | ((bytes[2] as i64) << 24)
        | ((bytes[3] as i64) << 16)
        | ((bytes[4] as i64) << 8)
        | bytes[5] as i64
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before Unix epoch")
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use agenttab_protocol::{NativeHandoff, NativeStagedCommit, NativeTab, RpcMethod};
    use serde_json::json;

    fn open_journal(temp: &tempfile::TempDir) -> Journal {
        Journal::open(&temp.path().join("state.sqlite3")).unwrap()
    }
    fn owned_tab(task_id: Uuid, page_revision: u64) -> NativeTab {
        NativeTab {
            tab_id: 7,
            window_id: 3,
            group_id: Some(11),
            url: "https://example.test/".into(),
            page_revision,
            task_id: Some(task_id),
        }
    }

    #[test]
    fn resume_capability_rotation_allows_one_pending_successor_and_rolls_back_failed_delivery() {
        let temp = tempfile::tempdir().unwrap();
        let journal = open_journal(&temp);
        let created = journal.create_task(Some("conversation")).unwrap();
        let pending = journal
            .resume_task(&created.resume_capability)
            .unwrap()
            .unwrap();
        assert_eq!(created.task_id, pending.task_id);
        assert_ne!(created.resume_capability, pending.resume_capability);
        assert!(journal
            .resume_task(&created.resume_capability)
            .unwrap()
            .is_none());
        assert!(matches!(
            journal.acknowledge_resume_capability(created.task_id, &created.resume_capability),
            Err(JournalError::ResumeRotationLost)
        ));

        journal
            .rollback_resume_capability(pending.task_id, &pending.resume_capability)
            .unwrap();
        let delivered = journal
            .resume_task(&created.resume_capability)
            .unwrap()
            .expect("the prior capability is retryable after failed delivery");
        journal
            .acknowledge_resume_capability(delivered.task_id, &delivered.resume_capability)
            .unwrap();
        assert!(journal
            .resume_task(&created.resume_capability)
            .unwrap()
            .is_none());
    }

    #[test]
    fn host_restart_discards_an_unconfirmed_candidate_and_preserves_the_old_capability() {
        let temp = tempfile::tempdir().unwrap();
        let state_path = temp.path().join("state.sqlite3");
        let (task_id, old_capability, candidate) = {
            let journal = Journal::open(&state_path).unwrap();
            let created = journal.create_task(None).unwrap();
            let candidate = journal
                .resume_task(&created.resume_capability)
                .unwrap()
                .unwrap();
            (
                created.task_id,
                created.resume_capability,
                candidate.resume_capability,
            )
        };

        let restarted = Journal::open(&state_path).unwrap();
        assert!(restarted.resume_task(&candidate).unwrap().is_none());
        assert_eq!(
            restarted
                .resume_task(&old_capability)
                .unwrap()
                .expect("the pre-confirmation capability remains recoverable")
                .task_id,
            task_id
        );
    }

    #[test]
    fn disconnected_task_remains_resumable_until_explicit_close() {
        let temp = tempfile::tempdir().unwrap();
        let journal = open_journal(&temp);
        let task = journal.create_task(None).unwrap();
        journal.detach_connection(task.task_id).unwrap();
        let resumed = journal
            .resume_task(&task.resume_capability)
            .unwrap()
            .unwrap();
        assert_eq!(resumed.task_id, task.task_id);
    }

    #[test]
    fn completed_mutation_is_replayed_and_input_conflicts_fail() {
        let temp = tempfile::tempdir().unwrap();
        let journal = open_journal(&temp);
        let task = journal.create_task(None).unwrap();
        let key = Uuid::now_v7();
        assert!(matches!(
            journal
                .begin_mutation(task.task_id, key, RpcMethod::BrowserAct, "hash-a")
                .unwrap(),
            BeginDecision::Dispatch
        ));
        journal
            .complete_mutation(task.task_id, key, &json!({"outcome": "completed"}))
            .unwrap();
        assert!(matches!(
            journal
                .begin_mutation(task.task_id, key, RpcMethod::BrowserAct, "hash-a")
                .unwrap(),
            BeginDecision::Cached(_)
        ));
        assert!(matches!(
            journal.begin_mutation(task.task_id, key, RpcMethod::BrowserAct, "hash-b"),
            Err(JournalError::IdempotencyConflict)
        ));
    }

    #[test]
    fn completed_records_older_than_retention_are_pruned() {
        let temp = tempfile::tempdir().unwrap();
        let journal = open_journal(&temp);
        let task = journal.create_task(None).unwrap();
        let old_key = Uuid::now_v7();
        journal
            .begin_mutation(task.task_id, old_key, RpcMethod::BrowserAct, "old")
            .unwrap();
        journal
            .complete_mutation(task.task_id, old_key, &json!({"outcome": "completed"}))
            .unwrap();
        journal
            .connection
            .lock()
            .execute(
                "UPDATE idempotency_journal SET completed_at_ms = ?1
                 WHERE task_id = ?2 AND idempotency_key = ?3",
                params![
                    now_ms() - IDEMPOTENCY_RETENTION_MS - 1,
                    task.task_id.to_string(),
                    old_key.to_string()
                ],
            )
            .unwrap();

        journal
            .begin_mutation(task.task_id, Uuid::now_v7(), RpcMethod::BrowserAct, "new")
            .unwrap();
        let retained: i64 = journal
            .connection
            .lock()
            .query_row(
                "SELECT COUNT(*) FROM idempotency_journal
                 WHERE task_id = ?1 AND idempotency_key = ?2",
                params![task.task_id.to_string(), old_key.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, 0);
    }

    #[test]
    fn started_record_survives_reopen_as_unknown() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.sqlite3");
        let task;
        let key = Uuid::now_v7();
        {
            let journal = Journal::open(&path).unwrap();
            task = journal.create_task(None).unwrap();
            journal
                .begin_mutation(task.task_id, key, RpcMethod::BrowserOpen, "hash")
                .unwrap();
        }
        let reopened = Journal::open(&path).unwrap();
        assert!(matches!(
            reopened
                .begin_mutation(task.task_id, key, RpcMethod::BrowserOpen, "hash")
                .unwrap(),
            BeginDecision::Unknown
        ));
    }

    #[test]
    fn completed_record_survives_reopen_and_replays_exact_response() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.sqlite3");
        let task;
        let key = Uuid::now_v7();
        let response = json!({
            "protocol": "agenttab.rpc",
            "version": 1,
            "request_id": "open-1",
            "outcome": "completed",
            "result": {"tab_id": 7}
        });
        {
            let journal = Journal::open(&path).unwrap();
            task = journal.create_task(None).unwrap();
            assert!(matches!(
                journal
                    .begin_mutation(task.task_id, key, RpcMethod::BrowserOpen, "hash")
                    .unwrap(),
                BeginDecision::Dispatch
            ));
            journal
                .complete_mutation(task.task_id, key, &response)
                .unwrap();
        }
        let reopened = Journal::open(&path).unwrap();
        match reopened
            .begin_mutation(task.task_id, key, RpcMethod::BrowserOpen, "hash")
            .unwrap()
        {
            BeginDecision::Cached(cached) => assert_eq!(cached, response),
            decision => panic!("expected cached response, got {decision:?}"),
        }
    }

    #[test]
    fn expired_and_future_uuidv7_keys_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let journal = open_journal(&temp);
        let task = journal.create_task(None).unwrap();

        let key_at = |timestamp_ms: i64| {
            let mut bytes = *Uuid::now_v7().as_bytes();
            bytes[..6].copy_from_slice(&(timestamp_ms as u64).to_be_bytes()[2..]);
            Uuid::from_bytes(bytes)
        };
        let expired = key_at(now_ms() - IDEMPOTENCY_RETENTION_MS - 1);
        let future = key_at(now_ms() + IDEMPOTENCY_FUTURE_SKEW_MS + 1);
        assert!(matches!(
            journal.begin_mutation(task.task_id, expired, RpcMethod::BrowserAct, "expired"),
            Err(JournalError::ExpiredKey)
        ));
        assert!(matches!(
            journal.begin_mutation(task.task_id, future, RpcMethod::BrowserAct, "future"),
            Err(JournalError::FutureKey)
        ));
    }

    #[test]
    fn staged_commit_is_bound_to_task_and_one_use() {
        let temp = tempfile::tempdir().unwrap();
        let journal = open_journal(&temp);
        let task = journal.create_task(None).unwrap();
        let other = journal.create_task(None).unwrap();
        journal
            .reconcile_inventory(&[owned_tab(task.task_id, 9)])
            .unwrap();
        let staged = NativeStagedCommit {
            native_token: "native-token-123456".into(),
            task_id: task.task_id,
            tab_id: 7,
            page_revision: 9,
            effect: "submit order".into(),
            fingerprint: "a".repeat(64),
            expires_at_ms: now_ms() + 60_000,
        };
        let mut invalid = staged.clone();
        invalid.expires_at_ms = now_ms() - 1;
        assert!(matches!(
            journal.store_staged_commit(&invalid, &[]),
            Err(JournalError::InvalidStagedExpiry)
        ));
        invalid.expires_at_ms = now_ms() + MAX_STAGE_LIFETIME_MS + 1_000;
        assert!(matches!(
            journal.store_staged_commit(&invalid, &[]),
            Err(JournalError::InvalidStagedExpiry)
        ));
        let upload_path = PathBuf::from("/private/upload-staging/fixture.upload");
        let token = journal
            .store_staged_commit(&staged, std::slice::from_ref(&upload_path))
            .unwrap();
        assert_eq!(
            journal
                .staged_commit_tab_id(task.task_id, &token.staged_token)
                .unwrap(),
            Some(7)
        );
        assert_eq!(
            journal
                .staged_commit_tab_id(other.task_id, &token.staged_token)
                .unwrap(),
            None
        );
        assert!(matches!(
            journal.consume_staged_commit(other.task_id, &token.staged_token, Uuid::now_v7()),
            Err(JournalError::InvalidStagedToken)
        ));
        assert!(matches!(
            journal.consume_staged_commit(task.task_id, &token.staged_token, Uuid::now_v7()),
            Ok(StagedCommitConsumption::ApprovalRequired)
        ));
        assert!(matches!(
            journal.approve_popup_staged_commit(task.task_id, 7, &token.review_handle),
            Ok(StagedCommitApproval::Approved)
        ));
        let StagedCommitConsumption::Ready(consumed) = journal
            .consume_staged_commit(task.task_id, &token.staged_token, Uuid::now_v7())
            .unwrap()
        else {
            panic!("fresh staged commit must be consumable");
        };
        assert_eq!(consumed.native_token, staged.native_token);
        assert_eq!(consumed.upload_paths, vec![upload_path.clone()]);
        assert_eq!(
            journal
                .staged_commit_tab_id(task.task_id, &token.staged_token)
                .unwrap(),
            Some(7)
        );
        assert!(matches!(
            journal.consume_staged_commit(task.task_id, &token.staged_token, Uuid::now_v7()),
            Err(JournalError::InvalidStagedToken)
        ));
        journal
            .finish_staged_commit(&consumed.native_token)
            .unwrap();
        assert_eq!(
            journal
                .staged_commit_tab_id(task.task_id, &token.staged_token)
                .unwrap(),
            None
        );
        assert!(journal
            .reconcile_staged_commits(std::slice::from_ref(&staged))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn unconsumed_staged_commits_are_removed_by_expiry_and_reconciliation() {
        let temp = tempfile::tempdir().unwrap();
        let journal = open_journal(&temp);
        let task = journal.create_task(None).unwrap();
        journal
            .reconcile_inventory(&[owned_tab(task.task_id, 9)])
            .unwrap();

        let direct_upload = temp.path().join("direct-expiry.upload");
        let direct = NativeStagedCommit {
            native_token: "native-token-direct-expiry".into(),
            task_id: task.task_id,
            tab_id: 7,
            page_revision: 9,
            effect: "upload file".into(),
            fingerprint: "d".repeat(64),
            expires_at_ms: now_ms() + 60_000,
        };
        let direct_handles = journal
            .store_staged_commit(&direct, std::slice::from_ref(&direct_upload))
            .unwrap();
        assert_eq!(
            journal.expire_staged_commit(&direct.native_token).unwrap(),
            vec![direct_upload],
        );
        assert!(matches!(
            journal.consume_staged_commit(
                task.task_id,
                &direct_handles.staged_token,
                Uuid::now_v7()
            ),
            Err(JournalError::InvalidStagedToken)
        ));

        let reconciled_upload = temp.path().join("reconciled-expiry.upload");
        let reconciled = NativeStagedCommit {
            native_token: "native-token-reconciled-expiry".into(),
            task_id: task.task_id,
            tab_id: 7,
            page_revision: 9,
            effect: "upload file".into(),
            fingerprint: "r".repeat(64),
            expires_at_ms: now_ms() + 60_000,
        };
        let reconciled_handles = journal
            .store_staged_commit(&reconciled, std::slice::from_ref(&reconciled_upload))
            .unwrap();
        Connection::open(temp.path().join("state.sqlite3"))
            .unwrap()
            .execute(
                "UPDATE staged_commits SET expires_at_ms = ?1 WHERE native_token = ?2",
                params![now_ms() - 1, reconciled.native_token],
            )
            .unwrap();
        assert_eq!(
            journal.reconcile_staged_commits(&[]).unwrap(),
            vec![reconciled_upload],
        );
        assert!(matches!(
            journal.consume_staged_commit(
                task.task_id,
                &reconciled_handles.staged_token,
                Uuid::now_v7()
            ),
            Err(JournalError::InvalidStagedToken)
        ));
    }

    #[test]
    fn expired_staged_commit_is_durably_removed_before_consumption() {
        let temp = tempfile::tempdir().unwrap();
        let journal = open_journal(&temp);
        let task = journal.create_task(None).unwrap();
        journal
            .reconcile_inventory(&[owned_tab(task.task_id, 9)])
            .unwrap();
        let upload_path = temp.path().join("expired-staged-upload");
        let staged = NativeStagedCommit {
            native_token: "native-token-expired-consumption".into(),
            task_id: task.task_id,
            tab_id: 7,
            page_revision: 9,
            effect: "submit order".into(),
            fingerprint: "e".repeat(64),
            expires_at_ms: now_ms() + 60_000,
        };
        let handles = journal
            .store_staged_commit(&staged, std::slice::from_ref(&upload_path))
            .unwrap();
        let commit_key = Uuid::now_v7();
        journal
            .begin_mutation(
                task.task_id,
                commit_key,
                RpcMethod::BrowserCommit,
                "expired",
            )
            .unwrap();
        Connection::open(temp.path().join("state.sqlite3"))
            .unwrap()
            .execute(
                "UPDATE staged_commits SET expires_at_ms = ?1 WHERE native_token = ?2",
                params![now_ms() - 1, staged.native_token],
            )
            .unwrap();

        let StagedCommitConsumption::Expired(paths) = journal
            .consume_staged_commit(task.task_id, &handles.staged_token, commit_key)
            .unwrap()
        else {
            panic!("an expired staged record must never be consumed");
        };
        assert_eq!(paths, vec![upload_path]);
        let BeginDecision::Cached(cached) = journal
            .lookup_mutation(
                task.task_id,
                commit_key,
                RpcMethod::BrowserCommit,
                "expired",
            )
            .unwrap()
            .unwrap()
        else {
            panic!("expiry consumption must terminalize the started commit before deletion");
        };
        assert_eq!(cached["outcome"], "not_started");
        assert_eq!(cached["error"]["code"], "staged_token_invalid");
        assert!(matches!(
            journal.consume_staged_commit(task.task_id, &handles.staged_token, commit_key),
            Err(JournalError::InvalidStagedToken)
        ));
    }

    #[test]
    fn popup_review_handle_is_private_and_approves_task_bound_commit() {
        let temp = tempfile::tempdir().unwrap();
        let journal = open_journal(&temp);
        let task = journal.create_task(None).unwrap();
        let other = journal.create_task(None).unwrap();
        journal
            .reconcile_inventory(&[owned_tab(task.task_id, 9)])
            .unwrap();
        let staged = NativeStagedCommit {
            native_token: "native-token-popup-review".into(),
            task_id: task.task_id,
            tab_id: 7,
            page_revision: 9,
            effect: "submit order".into(),
            fingerprint: "c".repeat(64),
            expires_at_ms: now_ms() + 60_000,
        };
        let upload = PathBuf::from("/private/upload-staging/popup-review.upload");
        let handles = journal
            .store_staged_commit(&staged, std::slice::from_ref(&upload))
            .unwrap();
        assert_ne!(handles.staged_token, handles.review_handle);
        assert!(matches!(
            journal.approve_popup_staged_commit(other.task_id, 7, &handles.review_handle),
            Err(JournalError::InvalidStagedToken)
        ));
        assert!(matches!(
            journal.approve_popup_staged_commit(task.task_id, 8, &handles.review_handle),
            Err(JournalError::InvalidStagedToken)
        ));
        assert!(matches!(
            journal.consume_staged_commit(task.task_id, &handles.staged_token, Uuid::now_v7(),),
            Ok(StagedCommitConsumption::ApprovalRequired)
        ));
        assert!(matches!(
            journal.approve_popup_staged_commit(task.task_id, 7, &handles.review_handle),
            Ok(StagedCommitApproval::Approved)
        ));
        assert!(matches!(
            journal.approve_popup_staged_commit(task.task_id, 7, &handles.review_handle),
            Ok(StagedCommitApproval::Approved)
        ));
        let StagedCommitConsumption::Ready(consumed) = journal
            .consume_staged_commit(task.task_id, &handles.staged_token, Uuid::now_v7())
            .unwrap()
        else {
            panic!("approved staged commit must be consumable");
        };
        assert_eq!(consumed.native_token, staged.native_token);
        assert_eq!(consumed.upload_paths, vec![upload]);
        journal
            .finish_staged_commit(&consumed.native_token)
            .unwrap();
        assert!(matches!(
            journal.approve_popup_staged_commit(task.task_id, 7, &handles.review_handle),
            Err(JournalError::InvalidStagedToken)
        ));
    }

    #[test]
    fn abandoning_popup_review_returns_uploads_and_removes_host_record() {
        let temp = tempfile::tempdir().unwrap();
        let journal = open_journal(&temp);
        let task = journal.create_task(None).unwrap();
        journal
            .reconcile_inventory(&[owned_tab(task.task_id, 9)])
            .unwrap();
        let staged = NativeStagedCommit {
            native_token: "native-token-popup-abandon".into(),
            task_id: task.task_id,
            tab_id: 7,
            page_revision: 9,
            effect: "upload file".into(),
            fingerprint: "d".repeat(64),
            expires_at_ms: now_ms() + 60_000,
        };
        let upload = PathBuf::from("/private/upload-staging/popup-abandon.upload");
        let handles = journal
            .store_staged_commit(&staged, std::slice::from_ref(&upload))
            .unwrap();
        assert_eq!(
            journal
                .abandon_popup_staged_commit(task.task_id, 7, &handles.review_handle)
                .unwrap(),
            vec![upload],
        );
        assert!(matches!(
            journal.consume_staged_commit(task.task_id, &handles.staged_token, Uuid::now_v7()),
            Err(JournalError::InvalidStagedToken)
        ));
    }
    #[test]
    fn ownership_and_revision_floor_reject_stale_operations_but_ignore_stale_inventory() {
        let temp = tempfile::tempdir().unwrap();
        let journal = open_journal(&temp);
        let task = journal.create_task(None).unwrap();
        journal
            .reconcile_inventory(&[owned_tab(task.task_id, 9)])
            .unwrap();
        assert_eq!(
            journal.verify_task_tab(task.task_id, 7, Some(9)).unwrap(),
            9
        );
        journal.update_task_tab_count(task.task_id, 3).unwrap();
        assert_eq!(
            journal.verify_task_tab(task.task_id, 7, Some(9)).unwrap(),
            9
        );
        let staged = NativeStagedCommit {
            native_token: "native-token-revision".into(),
            task_id: task.task_id,
            tab_id: 7,
            page_revision: 9,
            effect: "submit order".into(),
            fingerprint: "b".repeat(64),
            expires_at_ms: now_ms() + 60_000,
        };
        let token = journal.store_staged_commit(&staged, &[]).unwrap();
        assert!(matches!(
            journal.approve_popup_staged_commit(task.task_id, 7, &token.review_handle),
            Ok(StagedCommitApproval::Approved)
        ));
        journal
            .reconcile_inventory(&[owned_tab(task.task_id, 10)])
            .unwrap();
        assert!(matches!(
            journal.verify_task_tab(task.task_id, 7, Some(9)),
            Err(JournalError::StalePageRevision {
                expected: 9,
                actual: 10
            })
        ));
        assert!(matches!(
            journal.consume_staged_commit(task.task_id, &token.staged_token, Uuid::now_v7()),
            Err(JournalError::StaleStagedCommit)
        ));
        assert_eq!(
            journal
                .reconcile_inventory(&[owned_tab(task.task_id, 9)])
                .unwrap(),
            InventoryReconciliation::IgnoredStale,
        );
        assert_eq!(
            journal.verify_task_tab(task.task_id, 7, Some(10)).unwrap(),
            10
        );
    }

    #[test]
    fn handoff_clear_is_durable_before_idempotent_acknowledgement() {
        let temp = tempfile::tempdir().unwrap();
        let journal = open_journal(&temp);
        let active = NativeHandoff {
            active: true,
            task_id: Some(Uuid::now_v7()),
            tab_id: Some(7),
            started_at_ms: Some(now_ms()),
        };
        journal.reconcile_handoff(&active).unwrap();
        assert!(journal.handoff_active().unwrap());
        assert_eq!(
            journal.handoff_binding().unwrap(),
            Some((active.task_id.unwrap(), 7))
        );

        let clear = NativeHandoff {
            active: false,
            task_id: None,
            tab_id: None,
            started_at_ms: None,
        };
        assert!(matches!(
            journal.apply_handoff_event(&clear, None),
            Err(JournalError::MissingHandoffEventId)
        ));
        journal
            .apply_handoff_event(&clear, Some("handoff-clear-0001"))
            .unwrap();
        assert!(!journal.handoff_active().unwrap());
        journal
            .apply_handoff_event(&clear, Some("handoff-clear-0001"))
            .unwrap();
        assert!(matches!(
            journal.apply_handoff_event(&active, Some("handoff-clear-0001")),
            Err(JournalError::HandoffEventConflict)
        ));
        let reopened = open_journal(&temp);
        assert!(!reopened.handoff_active().unwrap());
        reopened
            .apply_handoff_event(&clear, Some("handoff-clear-0001"))
            .unwrap();
    }

    #[test]
    fn task_ownership_survives_missing_cosmetic_group_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let journal = open_journal(&temp);
        let task = journal.create_task(None).unwrap();
        let mut tab = owned_tab(task.task_id, 3);
        tab.group_id = None;

        journal.reconcile_inventory(&[tab]).unwrap();

        assert!(journal.verify_task_tab(task.task_id, 7, Some(3)).is_ok());
    }
}
