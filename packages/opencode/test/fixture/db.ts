import { Instance } from "../../src/project/instance"
import { zengramDb } from "../../src/storage/db.zengram"

// Tables to truncate between tests. The embedded Zeta runs in :memory: mode,
// so there are no files to delete — instead we drop row state to isolate
// each test.
const TABLES = [
  "event_log",
  "session",
  "branch",
  "turn",
  "part",
  "tool_call",
  "task",
  "task_dependency",
  "task_file",
  "provenance",
  "subagent_run",
  "knowledge",
  "project",
  "workspace",
  "session_share",
  "account",
  "account_state",
  "file_operation",
  "workspace_file",
  "snapshot",
  "environment",
  "embedding",
]

export async function resetDatabase() {
  await Instance.disposeAll().catch(() => undefined)
  const db = zengramDb()
  for (const table of TABLES) {
    await db.execute(`DELETE FROM ${table}`, []).catch(() => undefined)
  }
}
