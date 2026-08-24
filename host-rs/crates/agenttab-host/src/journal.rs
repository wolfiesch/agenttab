use agenttab_protocol::{NativeStagedCommit, RpcMethod};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use parking_lot::Mutex;
use rand::rngs::OsRng;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
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
    #[error("task is closed or missing")]
    MissingTask,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
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
}

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
                 previous_resume_hash BLOB,
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
             CREATE TABLE IF NOT EXISTS staged_commits (
                 token_hash BLOB PRIMARY KEY,
                 task_id TEXT NOT NULL,
                 native_token TEXT NOT NULL,
                 tab_id INTEGER NOT NULL,
                 page_revision INTEGER NOT NULL,
                 effect TEXT NOT NULL,
                 fingerprint TEXT NOT NULL,
                 expires_at_ms INTEGER NOT NULL,
                 used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1)),
                 FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
             );",
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
        ensure_column(&connection, "tasks", "previous_resume_hash", "BLOB")?;
        connection.execute("UPDATE tasks SET active_connections = 0", [])?;
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
                 WHERE (resume_hash = ?1 OR previous_resume_hash = ?1) AND state = 'active'",
                params![old_hash.as_slice()],
                |row| row.get(0),
            )
            .optional()?;
        let Some(task_id) = task_id else {
            transaction.rollback()?;
            return Ok(None);
        };
        transaction.execute(
            "UPDATE tasks
             SET previous_resume_hash = ?1,
                 resume_hash = ?2,
                 active_connections = active_connections + 1,
                 updated_at_ms = ?3
             WHERE task_id = ?4 AND state = 'active'",
            params![
                old_hash.as_slice(),
                next_hash.as_slice(),
                now,
                task_id
            ],
        )?;
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
        connection.execute(
            "UPDATE tasks
             SET previous_resume_hash = NULL, updated_at_ms = ?1
             WHERE task_id = ?2 AND resume_hash = ?3 AND state = 'active'",
            params![now_ms(), task_id.to_string(), capability_hash.as_slice()],
        )?;
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

    pub fn reconcile_inventory(&self, tab_counts: &[(Uuid, u64)]) -> Result<(), JournalError> {
        let now = now_ms();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute("UPDATE tasks SET tab_count = 0 WHERE state = 'active'", [])?;
        for (task_id, tab_count) in tab_counts {
            transaction.execute(
                "UPDATE tasks SET tab_count = ?1, updated_at_ms = ?2
                 WHERE task_id = ?3 AND state = 'active'",
                params![*tab_count as i64, now, task_id.to_string()],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn update_task_tab_count(&self, task_id: Uuid, tab_count: u64) -> Result<(), JournalError> {
        let now = now_ms();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "UPDATE tasks SET tab_count = ?1, updated_at_ms = ?2
             WHERE task_id = ?3 AND state = 'active'",
            params![tab_count as i64, now, task_id.to_string()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn close_task(&self, task_id: Uuid) -> Result<(), JournalError> {
        let now = now_ms();
        let connection = self.connection.lock();
        connection.execute(
            "UPDATE tasks
             SET state = 'closed', updated_at_ms = ?1, closed_at_ms = COALESCE(closed_at_ms, ?1)
             WHERE task_id = ?2",
            params![now, task_id.to_string()],
        )?;
        Ok(())
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

        let existing: Option<(String, String, String, Option<String>)> = transaction
            .query_row(
                "SELECT method, input_hash, state, response_json
                 FROM idempotency_journal
                 WHERE task_id = ?1 AND idempotency_key = ?2",
                params![task_id.to_string(), key.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some((stored_method, stored_hash, state, response_json)) = existing {
            if stored_method != method.to_string() || stored_hash != input_hash {
                transaction.rollback()?;
                return Err(JournalError::IdempotencyConflict);
            }
            let decision = if state == "completed" {
                BeginDecision::Cached(serde_json::from_str(
                    response_json
                        .as_deref()
                        .ok_or(JournalError::MissingStartedRecord)?,
                )?)
            } else {
                BeginDecision::Unknown
            };
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

    pub fn store_staged_commit(&self, staged: &NativeStagedCommit) -> Result<String, JournalError> {
        let now = now_ms();
        if staged.expires_at_ms <= now
            || staged.expires_at_ms > now.saturating_add(MAX_STAGE_LIFETIME_MS)
        {
            return Err(JournalError::InvalidStagedExpiry);
        }
        let host_token = generate_capability();
        let token_hash = capability_hash(&host_token);
        let connection = self.connection.lock();
        connection.execute(
            "INSERT INTO staged_commits(
                 token_hash, task_id, native_token, tab_id, page_revision,
                 effect, fingerprint, expires_at_ms, used
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)",
            params![
                token_hash.as_slice(),
                staged.task_id.to_string(),
                staged.native_token,
                staged.tab_id as i64,
                staged.page_revision as i64,
                staged.effect,
                staged.fingerprint,
                staged.expires_at_ms
            ],
        )?;
        Ok(host_token)
    }

    pub fn consume_staged_commit(
        &self,
        task_id: Uuid,
        host_token: &str,
    ) -> Result<StagedRecord, JournalError> {
        let token_hash = capability_hash(host_token);
        let now = now_ms();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM staged_commits WHERE expires_at_ms < ?1 OR used = 1",
            params![now],
        )?;
        let record: Option<(String, String, i64, i64, String, String, i64)> = transaction
            .query_row(
                "SELECT task_id, native_token, tab_id, page_revision, effect, fingerprint, expires_at_ms
                 FROM staged_commits
                 WHERE token_hash = ?1 AND task_id = ?2 AND used = 0 AND expires_at_ms >= ?3",
                params![token_hash.as_slice(), task_id.to_string(), now],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
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
        )) = record
        else {
            transaction.rollback()?;
            return Err(JournalError::InvalidStagedToken);
        };
        let updated = transaction.execute(
            "UPDATE staged_commits SET used = 1 WHERE token_hash = ?1 AND used = 0",
            params![token_hash.as_slice()],
        )?;
        if updated != 1 {
            transaction.rollback()?;
            return Err(JournalError::InvalidStagedToken);
        }
        transaction.commit()?;
        Ok(StagedRecord {
            task_id: Uuid::parse_str(&stored_task)?,
            native_token,
            tab_id: tab_id as u64,
            page_revision: page_revision as u64,
            effect,
            fingerprint,
            expires_at_ms,
        })
    }

    pub fn reconcile_staged_commits(
        &self,
        staged_commits: &[NativeStagedCommit],
    ) -> Result<(), JournalError> {
        let now = now_ms();
        let active_tokens = staged_commits
            .iter()
            .filter(|staged| staged.expires_at_ms >= now)
            .map(|staged| staged.native_token.as_str())
            .collect::<std::collections::HashSet<_>>();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM staged_commits WHERE expires_at_ms < ?1 OR used = 1",
            params![now],
        )?;
        let persisted_tokens = {
            let mut statement = transaction.prepare("SELECT native_token FROM staged_commits")?;
            let tokens = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            tokens
        };
        for native_token in persisted_tokens {
            if !active_tokens.contains(native_token.as_str()) {
                transaction.execute(
                    "DELETE FROM staged_commits WHERE native_token = ?1",
                    params![native_token],
                )?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn expire_staged_commit(&self, native_token: &str) -> Result<(), JournalError> {
        let connection = self.connection.lock();
        connection.execute(
            "DELETE FROM staged_commits WHERE native_token = ?1",
            params![native_token],
        )?;
        Ok(())
    }
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
    use agenttab_protocol::{NativeStagedCommit, RpcMethod};
    use serde_json::json;

    fn open_journal(temp: &tempfile::TempDir) -> Journal {
        Journal::open(&temp.path().join("state.sqlite3")).unwrap()
    }

    #[test]
    fn resume_capability_rotation_keeps_the_prior_token_until_delivery_ack() {
        let temp = tempfile::tempdir().unwrap();
        let journal = open_journal(&temp);
        let created = journal.create_task(Some("conversation")).unwrap();
        let undelivered = journal
            .resume_task(&created.resume_capability)
            .unwrap()
            .unwrap();
        assert_eq!(created.task_id, undelivered.task_id);
        assert_ne!(
            created.resume_capability,
            undelivered.resume_capability
        );

        let delivered = journal
            .resume_task(&created.resume_capability)
            .unwrap()
            .expect("the prior capability remains valid before delivery acknowledgment");
        journal
            .acknowledge_resume_capability(delivered.task_id, &delivered.resume_capability)
            .unwrap();
        assert!(journal
            .resume_task(&created.resume_capability)
            .unwrap()
            .is_none());
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
            bytes[..6].copy_from_slice(&timestamp_ms.to_be_bytes()[2..]);
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
            journal.store_staged_commit(&invalid),
            Err(JournalError::InvalidStagedExpiry)
        ));
        invalid.expires_at_ms = now_ms() + MAX_STAGE_LIFETIME_MS + 1_000;
        assert!(matches!(
            journal.store_staged_commit(&invalid),
            Err(JournalError::InvalidStagedExpiry)
        ));
        let token = journal.store_staged_commit(&staged).unwrap();
        assert!(matches!(
            journal.consume_staged_commit(other.task_id, &token),
            Err(JournalError::InvalidStagedToken)
        ));
        let consumed = journal.consume_staged_commit(task.task_id, &token).unwrap();
        assert_eq!(consumed.native_token, staged.native_token);
        assert!(matches!(
            journal.consume_staged_commit(task.task_id, &token),
            Err(JournalError::InvalidStagedToken)
        ));
    }
}
