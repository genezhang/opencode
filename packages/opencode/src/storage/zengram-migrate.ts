/**
 * TypeScript migration runner for the Zengram schema.
 *
 * Mirrors the Rust zengram-schema runner: applies versioned SQL migrations in
 * order, tracks applied migrations in `_zengram_migrations`, and verifies
 * checksums so schema drift is caught immediately.
 *
 * Uses the pg Simple Query Protocol for DDL (no params) so multi-statement
 * migration files are sent as a single query and execute within one round-trip.
 * Each migration is wrapped in a transaction so partial failures roll back
 * cleanly.
 */

import pg from "pg"
import crypto from "crypto"
import { Log } from "@/util/log"
import type { Database } from "zeta-db"

const log = Log.create({ service: "zengram-migrate" })

// ── Embedded migration SQL ────────────────────────────────────────────────────
// Inlined from zengram-schema/src/migrations/ so this module is self-contained
// in the compiled Bun binary with no external file references.

const V001 = `
-- Layer 0: Storage Primitives
CREATE TABLE event_log (
    lsn             BIGSERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    event_data      BYTEA NOT NULL,
    branch_id       TEXT,
    parent_lsn      BIGINT,
    agent_id        TEXT,
    severity        TEXT DEFAULT 'info',
    time_created    BIGINT NOT NULL
);
CREATE INDEX event_log_session_idx ON event_log(session_id, lsn);
CREATE INDEX event_log_type_idx ON event_log(event_type, lsn);
CREATE TABLE embedding (
    id              TEXT PRIMARY KEY,
    source_type     TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    content_text    TEXT NOT NULL,
    vector          BYTEA,
    model           TEXT NOT NULL,
    dimensions      INTEGER NOT NULL,
    time_created    BIGINT NOT NULL
);
CREATE INDEX embedding_source_idx ON embedding(source_type, source_id);
`

const V002 = `
-- Layer 1: Core Agent State
CREATE TABLE project (
    id              TEXT PRIMARY KEY,
    name            TEXT,
    root_path       TEXT,
    metadata        JSONB,
    time_created    BIGINT NOT NULL,
    time_updated    BIGINT NOT NULL
);
CREATE TABLE session (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES project(id),
    parent_id       TEXT REFERENCES session(id),
    title           TEXT NOT NULL DEFAULT '',
    slug            TEXT NOT NULL,
    agent           TEXT,
    model_id        TEXT,
    provider_id     TEXT,
    channel_type    TEXT,
    channel_account TEXT,
    channel_peer    TEXT,
    channel_meta    JSONB,
    status          TEXT NOT NULL DEFAULT 'active',
    active_branch   TEXT,
    total_tokens    BIGINT DEFAULT 0,
    total_cost_usd  DOUBLE PRECISION DEFAULT 0,
    total_turns     INTEGER DEFAULT 0,
    time_created    BIGINT NOT NULL,
    time_updated    BIGINT NOT NULL,
    time_archived   BIGINT
);
CREATE INDEX session_project_idx ON session(project_id, time_created DESC);
CREATE INDEX session_parent_idx ON session(parent_id);
CREATE TABLE branch (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES session(id),
    parent_branch   TEXT REFERENCES branch(id),
    fork_turn_id    TEXT,
    name            TEXT,
    status          TEXT DEFAULT 'active',
    merge_target    TEXT REFERENCES branch(id),
    time_created    BIGINT NOT NULL,
    time_updated    BIGINT NOT NULL
);
CREATE INDEX branch_session_idx ON branch(session_id);
CREATE TABLE turn (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES session(id),
    branch_id       TEXT NOT NULL REFERENCES branch(id),
    parent_turn_id  TEXT REFERENCES turn(id),
    role            TEXT NOT NULL,
    agent           TEXT,
    tokens_input    INTEGER DEFAULT 0,
    tokens_output   INTEGER DEFAULT 0,
    tokens_reasoning INTEGER DEFAULT 0,
    tokens_cache_read INTEGER DEFAULT 0,
    tokens_cache_write INTEGER DEFAULT 0,
    cost_usd        DOUBLE PRECISION DEFAULT 0,
    status          TEXT DEFAULT 'active',
    tier            TEXT DEFAULT 'hot',
    finish_reason   TEXT,
    summary         TEXT,
    summary_model   TEXT,
    time_created    BIGINT NOT NULL,
    time_completed  BIGINT
);
CREATE INDEX turn_session_branch_idx ON turn(session_id, branch_id, time_created);
CREATE INDEX turn_tier_idx ON turn(session_id, tier);
CREATE TABLE part (
    id              TEXT PRIMARY KEY,
    turn_id         TEXT NOT NULL REFERENCES turn(id),
    session_id      TEXT NOT NULL,
    type            TEXT NOT NULL,
    data            JSONB NOT NULL,
    content_hash    TEXT,
    position        INTEGER NOT NULL,
    time_created    BIGINT NOT NULL,
    time_updated    BIGINT NOT NULL
);
CREATE INDEX part_turn_idx ON part(turn_id, position);
CREATE INDEX part_session_type_idx ON part(session_id, type);
CREATE TABLE tool_call (
    id              TEXT PRIMARY KEY,
    turn_id         TEXT NOT NULL REFERENCES turn(id),
    part_id         TEXT NOT NULL REFERENCES part(id),
    session_id      TEXT NOT NULL,
    tool_id         TEXT NOT NULL,
    tool_source     TEXT DEFAULT 'builtin',
    state           TEXT NOT NULL DEFAULT 'pending',
    input           JSONB NOT NULL,
    output          TEXT,
    output_hash     TEXT,
    error           TEXT,
    duration_ms     INTEGER,
    tokens_consumed INTEGER DEFAULT 0,
    permission_type TEXT,
    permission_patterns JSONB,
    permission_action TEXT,
    category        TEXT,
    target_paths    JSONB,
    time_created    BIGINT NOT NULL,
    time_completed  BIGINT
);
CREATE INDEX tool_call_session_idx ON tool_call(session_id, time_created);
CREATE INDEX tool_call_tool_idx ON tool_call(tool_id, session_id);
CREATE INDEX tool_call_category_idx ON tool_call(category, session_id);
CREATE TABLE task (
    id              TEXT PRIMARY KEY,
    session_id      TEXT REFERENCES session(id),
    project_id      TEXT REFERENCES project(id),
    parent_task_id  TEXT REFERENCES task(id),
    title           TEXT NOT NULL,
    description     TEXT,
    priority        TEXT DEFAULT 'medium',
    status          TEXT DEFAULT 'pending',
    assigned_agent  TEXT,
    assigned_branch TEXT REFERENCES branch(id),
    acceptance      TEXT,
    verification    TEXT,
    source_turn_id  TEXT REFERENCES turn(id),
    completion_turn TEXT REFERENCES turn(id),
    estimated_turns INTEGER,
    actual_turns    INTEGER,
    time_created    BIGINT NOT NULL,
    time_started    BIGINT,
    time_completed  BIGINT
);
CREATE INDEX task_project_idx ON task(project_id, status);
CREATE INDEX task_session_idx ON task(session_id, status);
CREATE TABLE task_dependency (
    task_id         TEXT NOT NULL REFERENCES task(id),
    depends_on      TEXT NOT NULL REFERENCES task(id),
    type            TEXT DEFAULT 'blocks',
    PRIMARY KEY (task_id, depends_on)
);
CREATE TABLE task_file (
    task_id         TEXT NOT NULL REFERENCES task(id),
    file_path       TEXT NOT NULL,
    role            TEXT DEFAULT 'target',
    PRIMARY KEY (task_id, file_path)
);
CREATE TABLE permission_rule (
    id              TEXT PRIMARY KEY,
    project_id      TEXT REFERENCES project(id),
    session_id      TEXT REFERENCES session(id),
    permission      TEXT NOT NULL,
    pattern         TEXT NOT NULL,
    action          TEXT NOT NULL,
    context_agent   TEXT,
    context_branch  TEXT,
    context_path_prefix TEXT,
    context_risk_max DOUBLE PRECISION,
    trust_level     DOUBLE PRECISION DEFAULT 0.5,
    times_granted   INTEGER DEFAULT 0,
    times_denied    INTEGER DEFAULT 0,
    source          TEXT DEFAULT 'user',
    priority        INTEGER DEFAULT 0,
    time_created    BIGINT NOT NULL,
    time_expires    BIGINT
);
CREATE INDEX permission_rule_project_idx ON permission_rule(project_id, permission);
CREATE INDEX permission_rule_session_idx ON permission_rule(session_id, permission);
CREATE TABLE provenance (
    id              TEXT PRIMARY KEY,
    session_id      TEXT REFERENCES session(id),
    source_type     TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    target_type     TEXT NOT NULL,
    target_id       TEXT NOT NULL,
    relation        TEXT NOT NULL,
    confidence      DOUBLE PRECISION DEFAULT 1.0,
    time_created    BIGINT NOT NULL
);
CREATE INDEX provenance_source_idx ON provenance(source_type, source_id);
CREATE INDEX provenance_target_idx ON provenance(target_type, target_id);
CREATE TABLE agent_mailbox (
    id              TEXT PRIMARY KEY,
    from_agent      TEXT NOT NULL,
    to_agent        TEXT NOT NULL,
    message_type    TEXT NOT NULL,
    payload         JSONB NOT NULL,
    status          TEXT DEFAULT 'pending',
    claimed_by      TEXT,
    session_id      TEXT,
    reply_to        TEXT REFERENCES agent_mailbox(id),
    time_created    BIGINT NOT NULL,
    time_claimed    BIGINT,
    time_processed  BIGINT,
    time_expires    BIGINT
);
CREATE INDEX agent_mailbox_to_idx ON agent_mailbox(to_agent, status, time_created);
CREATE INDEX agent_mailbox_session_idx ON agent_mailbox(session_id);
CREATE TABLE subagent_run (
    id              TEXT PRIMARY KEY,
    parent_session  TEXT NOT NULL REFERENCES session(id),
    child_session   TEXT REFERENCES session(id),
    agent_type      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'running',
    spawn_depth     INTEGER DEFAULT 0,
    result          TEXT,
    error           TEXT,
    time_created    BIGINT NOT NULL,
    time_completed  BIGINT,
    runtime_ms      BIGINT DEFAULT 0
);
CREATE INDEX subagent_run_parent_idx ON subagent_run(parent_session, status);
`

const V003 = `
-- Layer 2: Intelligence Layer
CREATE TABLE knowledge (
    id              TEXT PRIMARY KEY,
    project_id      TEXT REFERENCES project(id),
    scope           TEXT NOT NULL DEFAULT '/',
    categories      JSONB,
    subject         TEXT NOT NULL,
    content         TEXT NOT NULL,
    valid_from      BIGINT,
    valid_to        BIGINT,
    importance      DOUBLE PRECISION DEFAULT 0.5,
    confidence      DOUBLE PRECISION DEFAULT 0.5,
    access_count    INTEGER DEFAULT 0,
    last_accessed   BIGINT,
    similarity_hash TEXT,
    consolidated_from JSONB,
    superseded_by   TEXT REFERENCES knowledge(id),
    source_type     TEXT DEFAULT 'agent',
    source_session  TEXT REFERENCES session(id),
    source_turn     TEXT REFERENCES turn(id),
    private         BOOLEAN DEFAULT FALSE,
    status          TEXT DEFAULT 'active',
    times_confirmed INTEGER DEFAULT 0,
    times_contradicted INTEGER DEFAULT 0,
    time_created    BIGINT NOT NULL,
    time_updated    BIGINT NOT NULL,
    time_expires    BIGINT
);
CREATE INDEX knowledge_scope_idx ON knowledge(scope, status, importance DESC);
CREATE INDEX knowledge_project_idx ON knowledge(project_id, status);
CREATE INDEX knowledge_subject_idx ON knowledge(subject);
CREATE INDEX knowledge_validity_idx ON knowledge(valid_from, valid_to, status);
CREATE TABLE extraction_config (
    scope           TEXT PRIMARY KEY,
    enabled         BOOLEAN DEFAULT TRUE,
    extract_on      TEXT DEFAULT 'assistant_turn',
    min_turn_tokens INTEGER DEFAULT 100,
    reflection_trigger TEXT DEFAULT 'session_end',
    reflection_scope TEXT DEFAULT 'session',
    categories_prompt TEXT,
    time_updated    BIGINT NOT NULL
);
CREATE TABLE retrieval_config (
    scope           TEXT PRIMARY KEY,
    vector_weight   DOUBLE PRECISION DEFAULT 0.4,
    text_weight     DOUBLE PRECISION DEFAULT 0.3,
    recency_weight  DOUBLE PRECISION DEFAULT 0.15,
    importance_weight DOUBLE PRECISION DEFAULT 0.15,
    mmr_lambda      DOUBLE PRECISION DEFAULT 0.7,
    decay_half_life_days INTEGER DEFAULT 30,
    limit_default   INTEGER DEFAULT 20,
    score_threshold DOUBLE PRECISION DEFAULT 0.15
);
CREATE TABLE storage_budget (
    scope           TEXT PRIMARY KEY,
    max_bytes       BIGINT,
    high_water_bytes BIGINT,
    current_bytes   BIGINT DEFAULT 0,
    last_pruned     BIGINT,
    prune_strategy  TEXT DEFAULT 'oldest',
    retain_min      INTEGER DEFAULT 10,
    time_updated    BIGINT NOT NULL
);
CREATE TABLE token_estimate (
    entity_type     TEXT NOT NULL,
    entity_id       TEXT NOT NULL,
    model_family    TEXT NOT NULL,
    token_count     INTEGER NOT NULL,
    time_computed   BIGINT NOT NULL,
    PRIMARY KEY (entity_type, entity_id, model_family)
);
CREATE TABLE demotion_config (
    scope           TEXT PRIMARY KEY,
    hot_budget_pct  DOUBLE PRECISION DEFAULT 0.80,
    reserve_pct     DOUBLE PRECISION DEFAULT 0.15,
    strategy        TEXT DEFAULT 'hybrid',
    min_tokens_freed INTEGER DEFAULT 20000,
    warm_ttl_days   INTEGER DEFAULT 90,
    cold_ttl_days   INTEGER DEFAULT 365
);
`

const V004 = `
-- Property graph definition for SQL/PGQ graph queries.
CREATE PROPERTY GRAPH agent_graph
  VERTEX TABLES (
    session
      KEY (id)
      LABEL Session
      PROPERTIES (id, title, status, agent, channel_type, total_tokens, total_cost_usd),
    turn
      KEY (id)
      LABEL Turn
      PROPERTIES (id, role, status, tier, tokens_output, cost_usd, finish_reason),
    tool_call
      KEY (id)
      LABEL ToolCall
      PROPERTIES (id, tool_id, state, category, duration_ms, error),
    knowledge
      KEY (id)
      LABEL Knowledge
      PROPERTIES (id, subject, content, scope, importance, confidence, status),
    task
      KEY (id)
      LABEL Task
      PROPERTIES (id, title, status, priority, assigned_agent)
  )
  EDGE TABLES (
    turn
      SOURCE KEY (session_id) REFERENCES session (id)
      DESTINATION KEY (id) REFERENCES turn (id)
      LABEL HAS_TURN
      NO PROPERTIES,
    tool_call
      SOURCE KEY (turn_id) REFERENCES turn (id)
      DESTINATION KEY (id) REFERENCES tool_call (id)
      LABEL INVOKED
      NO PROPERTIES,
    task_dependency
      SOURCE KEY (task_id) REFERENCES task (id)
      DESTINATION KEY (depends_on) REFERENCES task (id)
      LABEL DEPENDS_ON
      PROPERTIES (type),
    subagent_run
      SOURCE KEY (parent_session) REFERENCES session (id)
      DESTINATION KEY (child_session) REFERENCES session (id)
      LABEL SPAWNED
      PROPERTIES (agent_type, status, runtime_ms)
  );
`

const V005 = `
-- Cross-cutting: State portability.
CREATE TABLE state_snapshot (
    id              TEXT PRIMARY KEY,
    project_id      TEXT REFERENCES project(id),
    type            TEXT NOT NULL,
    version         INTEGER NOT NULL,
    includes        JSONB NOT NULL,
    path_mappings   JSONB,
    location        TEXT NOT NULL,
    size_bytes      BIGINT,
    checksum        TEXT,
    status          TEXT DEFAULT 'active',
    time_created    BIGINT NOT NULL
);
`

const V006 = `
-- Layer 3a: Coding agent extension
CREATE TABLE IF NOT EXISTS file_operation (
    id              TEXT PRIMARY KEY,
    tool_call_id    TEXT NOT NULL REFERENCES tool_call(id),
    session_id      TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    operation       TEXT NOT NULL,
    content_hash    TEXT,
    diff            TEXT,
    additions       INTEGER DEFAULT 0,
    deletions       INTEGER DEFAULT 0,
    depth           TEXT DEFAULT 'listed',
    time_created    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS file_op_path_idx ON file_operation(file_path, session_id, time_created DESC);
CREATE INDEX IF NOT EXISTS file_op_session_idx ON file_operation(session_id, time_created DESC);
CREATE TABLE IF NOT EXISTS workspace_file (
    session_id      TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    understanding   TEXT DEFAULT 'unknown',
    relevance       REAL DEFAULT 0,
    content_hash    TEXT,
    last_read_turn  TEXT REFERENCES turn(id),
    last_write_turn TEXT REFERENCES turn(id),
    edit_state      TEXT DEFAULT 'clean',
    related_test    TEXT,
    purpose         TEXT,
    time_updated    BIGINT NOT NULL,
    PRIMARY KEY (session_id, file_path)
);
CREATE INDEX IF NOT EXISTS workspace_file_session_idx ON workspace_file(session_id, relevance DESC);
CREATE TABLE IF NOT EXISTS snapshot (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    turn_id         TEXT REFERENCES turn(id),
    tree_hash       TEXT NOT NULL,
    type            TEXT NOT NULL,
    additions       INTEGER DEFAULT 0,
    deletions       INTEGER DEFAULT 0,
    files_changed   INTEGER DEFAULT 0,
    time_created    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshot_session_idx ON snapshot(session_id, time_created DESC);
CREATE TABLE IF NOT EXISTS environment (
    id              TEXT PRIMARY KEY,
    session_id      TEXT REFERENCES session(id),
    project_id      TEXT REFERENCES project(id),
    type            TEXT NOT NULL,
    status          TEXT NOT NULL,
    snapshot_ref    TEXT,
    setup_script    TEXT,
    working_dir     TEXT,
    resource_budget TEXT,
    resource_used   TEXT,
    time_created    BIGINT NOT NULL,
    time_updated    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS environment_session_idx ON environment(session_id, status);
CREATE INDEX IF NOT EXISTS environment_project_idx ON environment(project_id, status);
`

const V007 = `
-- V007: OpenCode compatibility extensions.
CREATE TABLE IF NOT EXISTS workspace (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES project(id),
    type            TEXT NOT NULL,
    branch          TEXT,
    name            TEXT,
    directory       TEXT,
    extra           JSONB,
    time_created    BIGINT NOT NULL,
    time_updated    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_project_idx ON workspace(project_id);
CREATE TABLE IF NOT EXISTS session_share (
    session_id      TEXT PRIMARY KEY REFERENCES session(id),
    share_id        TEXT NOT NULL,
    secret          TEXT NOT NULL,
    url             TEXT NOT NULL,
    time_created    BIGINT NOT NULL,
    time_updated    BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS account (
    id              TEXT PRIMARY KEY,
    email           TEXT NOT NULL,
    url             TEXT NOT NULL,
    access_token    TEXT NOT NULL,
    refresh_token   TEXT NOT NULL,
    token_expiry    BIGINT,
    time_created    BIGINT NOT NULL,
    time_updated    BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_state (
    id                  INTEGER PRIMARY KEY,
    active_account_id   TEXT REFERENCES account(id),
    active_org_id       TEXT
);
ALTER TABLE project ADD COLUMN worktree         TEXT;
ALTER TABLE project ADD COLUMN vcs              TEXT;
ALTER TABLE project ADD COLUMN icon_url         TEXT;
ALTER TABLE project ADD COLUMN icon_color       TEXT;
ALTER TABLE project ADD COLUMN sandboxes        JSONB;
ALTER TABLE project ADD COLUMN commands         JSONB;
ALTER TABLE project ADD COLUMN time_initialized BIGINT;
ALTER TABLE session ADD COLUMN workspace_id      TEXT REFERENCES workspace(id);
ALTER TABLE session ADD COLUMN directory         TEXT;
ALTER TABLE session ADD COLUMN version           TEXT;
ALTER TABLE session ADD COLUMN share_url         TEXT;
ALTER TABLE session ADD COLUMN summary_additions INTEGER DEFAULT 0;
ALTER TABLE session ADD COLUMN summary_deletions INTEGER DEFAULT 0;
ALTER TABLE session ADD COLUMN summary_files     INTEGER DEFAULT 0;
ALTER TABLE session ADD COLUMN summary_diffs     JSONB;
ALTER TABLE session ADD COLUMN revert_state      JSONB;
ALTER TABLE session ADD COLUMN permission_json   JSONB;
ALTER TABLE session ADD COLUMN time_compacting   BIGINT;
CREATE INDEX IF NOT EXISTS session_workspace_idx ON session(workspace_id);
`

const V008 = `
-- V008: Turn model/provider tracking.
ALTER TABLE turn ADD COLUMN IF NOT EXISTS model_id    TEXT;
ALTER TABLE turn ADD COLUMN IF NOT EXISTS provider_id TEXT;
`

const V009 = `
-- V009: Knowledge vector embedding column + HNSW index.
ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS embedding VECTOR(384);
CREATE INDEX IF NOT EXISTS knowledge_embedding_idx
  ON knowledge USING hnsw (embedding)
  WITH (m = 16, ef_construction = 64);
`

// ── Migration registry ────────────────────────────────────────────────────────

const MIGRATIONS = [
  { version: 1, name: "layer0_storage",       sql: V001 },
  { version: 2, name: "layer1_core",           sql: V002 },
  { version: 3, name: "layer2_intelligence",   sql: V003 },
  { version: 4, name: "property_graph",        sql: V004 },
  { version: 5, name: "cross_cutting",         sql: V005 },
  { version: 6, name: "layer3_coding",         sql: V006 },
  { version: 7, name: "opencode_extensions",   sql: V007 },
  { version: 8, name: "turn_opencode_fields",  sql: V008 },
  { version: 9, name: "knowledge_vector",      sql: V009 },
]

function checksum(sql: string): string {
  return crypto.createHash("sha256").update(sql, "utf8").digest("hex")
}

function versionLabel(version: number, name: string): string {
  return `V${String(version).padStart(3, "0")}__${name}`
}

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * Apply all pending Zengram schema migrations.
 *
 * Creates the `_zengram_migrations` tracking table if absent, then applies
 * each unapplied migration inside its own transaction. Fails fast on the
 * first error. Verifies checksums of already-applied migrations so schema
 * drift is detected immediately.
 *
 * Returns the number of migrations applied in this call (0 = already up to date).
 */
export async function runMigrations(pool: pg.Pool): Promise<number> {
  const client = await pool.connect()
  try {
    // Create tracking table via simple query (no params needed).
    await client.query(`
      CREATE TABLE IF NOT EXISTS _zengram_migrations (
        version     INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        checksum    TEXT NOT NULL,
        applied_at  BIGINT NOT NULL
      )
    `)

    const result = await client.query(
      "SELECT version, checksum FROM _zengram_migrations ORDER BY version",
    )
    const applied = new Map<number, string>(
      result.rows.map((r) => [r.version as number, r.checksum as string]),
    )

    let count = 0

    for (const m of MIGRATIONS) {
      const cs = checksum(m.sql)
      const label = versionLabel(m.version, m.name)
      const existingCs = applied.get(m.version)

      if (existingCs !== undefined) {
        if (existingCs !== cs) {
          throw new Error(`Checksum mismatch for ${label}: stored=${existingCs} computed=${cs}`)
        }
        continue // already applied
      }

      log.info("applying migration", { label })
      process.stderr.write(`[opencode] Applying migration ${label}...\n`)

      try {
        // DDL + tracking record in a single transaction.
        // Simple query protocol handles multi-statement SQL in m.sql.
        await client.query("BEGIN")
        await client.query(m.sql)
        // Inline values — all are safe constants, no injection risk.
        const now = Date.now() * 1000
        await client.query(
          `INSERT INTO _zengram_migrations (version, name, checksum, applied_at)` +
            ` VALUES (${m.version}, '${m.name}', '${cs}', ${now})`,
        )
        await client.query("COMMIT")
        count++
        log.info("migration applied", { label })
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {})
        throw new Error(`Failed to apply ${label}: ${e}`)
      }
    }

    if (count === 0) {
      log.info("migrations: schema is up to date")
    } else {
      log.info("migrations applied", { count })
      process.stderr.write(`[opencode] Applied ${count} migration(s).\n`)
    }

    return count
  } finally {
    client.release()
  }
}

/**
 * Apply all pending Zengram schema migrations using the embedded NAPI driver.
 *
 * Mirrors runMigrations() but uses db.runScript() for multi-statement DDL
 * (maps to zeta_exec_batch which handles semicolon-delimited statements) and
 * a plain execute() for the tracking record insert. No pg.Pool required.
 *
 * Atomicity note: DDL in Zeta auto-commits per statement. If the process dies
 * between runScript() and the tracking insert, the next run detects the missing
 * tracking row and re-runs the migration — Zeta's CREATE TABLE IF NOT EXISTS
 * and CREATE INDEX IF NOT EXISTS make re-running safe.
 *
 * Returns the number of migrations applied in this call (0 = already up to date).
 */
export function runEmbeddedMigrations(db: Database): number {
  // Create tracking table (single-statement DDL — execute() routes to zeta_exec).
  db.execute(
    `CREATE TABLE IF NOT EXISTS _zengram_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      applied_at  BIGINT NOT NULL
    )`,
  )

  const appliedRows = db.query(
    "SELECT version, checksum FROM _zengram_migrations ORDER BY version",
  ) as Array<{ version: number; checksum: string }>

  const applied = new Map<number, string>(
    appliedRows.map((r) => [Number(r.version), String(r.checksum)]),
  )

  let count = 0

  for (const m of MIGRATIONS) {
    const cs = checksum(m.sql)
    const label = versionLabel(m.version, m.name)
    const existingCs = applied.get(m.version)

    if (existingCs !== undefined) {
      if (existingCs !== cs) {
        throw new Error(`Checksum mismatch for ${label}: stored=${existingCs} computed=${cs}`)
      }
      continue // already applied
    }

    log.info("applying migration (embedded)", { label })
    process.stderr.write(`[opencode] Applying migration ${label}...\n`)

    try {
      // Multi-statement DDL: runScript() → zeta_exec_batch handles semicolons.
      db.runScript(m.sql)
      // Record that this migration was applied.
      const now = Date.now() * 1000
      db.execute(
        `INSERT INTO _zengram_migrations (version, name, checksum, applied_at)` +
          ` VALUES (${m.version}, '${m.name}', '${cs}', ${now})`,
      )
      count++
      log.info("migration applied (embedded)", { label })
    } catch (e) {
      throw new Error(`Failed to apply ${label}: ${e}`)
    }
  }

  if (count === 0) {
    log.info("migrations: schema is up to date (embedded)")
  } else {
    log.info("migrations applied (embedded)", { count })
    process.stderr.write(`[opencode] Applied ${count} migration(s).\n`)
  }

  return count
}
