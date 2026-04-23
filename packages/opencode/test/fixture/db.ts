import { Instance } from "../../src/project/instance"
import { zengramDb } from "../../src/storage/db.zengram"

// Tables to truncate between tests, ordered children → parents so foreign-key
// references are removed before their targets. The embedded Zeta runs in
// :memory: mode, so there are no files to delete — we drop row state to isolate
// each test.
const TABLES = [
  "event_log",
  "file_operation",
  "workspace_file",
  "provenance",
  "embedding",
  "tool_call",
  "part",
  "task_dependency",
  "task_file",
  "task",
  "knowledge",
  "environment",
  "subagent_run",
  "session_share",
  "turn",
  "branch",
  "snapshot",
  "session",
  "workspace",
  "account_state",
  "account",
  "project",
]

export async function resetDatabase() {
  await Instance.disposeAll().catch(() => undefined)
  const db = zengramDb()
  for (const table of TABLES) {
    await db.execute(`DELETE FROM ${table}`, [])
  }
}
