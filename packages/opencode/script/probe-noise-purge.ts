/**
 * Dry-run for purgeReasoningNoise — list active /project facts in the
 * pinned-state DB that would be demoted to status='inactive', without
 * actually mutating the DB. Used to validate the REASONING_NOISE_RE filter
 * before running purgeReasoningNoise() for real.
 *
 * Usage:
 *   XDG_DATA_HOME=/path/to/pinned/state \
 *   bun packages/opencode/script/probe-noise-purge.ts
 */
import path from "node:path"
import fs from "node:fs"

async function main(): Promise<void> {
  if (!process.env.XDG_DATA_HOME) {
    console.error("ERROR: XDG_DATA_HOME must point at a pinned bench state dir")
    process.exit(1)
  }
  const { initEmbedded, rawEmbeddedDb } = await import("../src/storage/db.embedded")
  const { zengramDb } = await import("../src/storage/db.zengram")
  const { runEmbeddedMigrations } = await import("../src/storage/zengram-migrate")
  const { Global } = await import("../src/global")

  const dataDir = path.join(Global.Path.data, "zeta")
  if (!fs.existsSync(dataDir)) {
    console.error(`ERROR: ${dataDir} does not exist`)
    process.exit(1)
  }
  initEmbedded(dataDir, "lsm")
  runEmbeddedMigrations(rawEmbeddedDb())
  const db = zengramDb()

  // Mirror REASONING_NOISE_RE from src/knowledge/index.ts. Keep in sync —
  // small enough that duplicating beats wiring an export through.
  const noise = /^(?:\*{0,2})(now\s+(?:i|let)|let\s+me|let's|i(?:'ll|'m| (?:see|can|need|will|understand|think|believe|notice|realize))|looking at|i see|perfect[!.]|great[!.]|the (?:problem|issue|bug|fix) (?:is|seems|appears|looks|here|now)|so |actually,|wait,|hmm,|first,|then,|next,|after that)/i

  const rows = await db.query<{ id: string; subject: string; content: string; scope: string }>(
    `SELECT id, subject, content, scope FROM knowledge
     WHERE status = 'active' AND scope = '/project'
     ORDER BY scope ASC`,
  )
  const noisy = rows.filter((r) => noise.test(r.subject.trim()) || noise.test(r.content.trim()))

  console.log(`Total active /project facts: ${rows.length}`)
  console.log(`Would purge:                 ${noisy.length}`)
  console.log(`Pct noise:                   ${((100 * noisy.length) / rows.length).toFixed(1)}%`)
  console.log("")
  console.log("=== Would purge ===")
  for (const r of noisy) {
    console.log(`[${r.id.slice(0, 12)}…] ${r.subject.slice(0, 100)}`)
  }
  console.log("")
  console.log("=== Would keep (sample of first 20) ===")
  const kept = rows.filter((r) => !noisy.includes(r))
  for (const r of kept.slice(0, 20)) {
    console.log(`[${r.id.slice(0, 12)}…] ${r.subject.slice(0, 100)}`)
  }
}

main().catch((e) => {
  console.error("dry-run failed:", e)
  process.exit(1)
})
