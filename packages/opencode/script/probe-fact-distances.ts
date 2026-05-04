/**
 * Probe the cosine-distance distribution of `recallFacts` across a task pool.
 *
 * For each task's problem statement, query the project knowledge table for
 * every active fact's distance to the embedded query, and dump a histogram
 * + per-task top-k. Used to pick an empirical ZENGRAM_FACT_MAX_DISTANCE
 * cutoff before running a bench cycle.
 *
 * Usage:
 *   XDG_DATA_HOME=/path/to/pinned/state \
 *   bun packages/opencode/script/probe-fact-distances.ts \
 *     --tasks /home/gene/zengram-bench/tasks/cache/tasks.json \
 *     [--top 10]
 *
 * The pinned-state dir must contain `opencode/zeta/...` from a prior bench run.
 */
import path from "node:path"
import fs from "node:fs"

interface Task {
  task_id: string
  problem_statement: string
}

function parseArgs(): { tasksPath: string; top: number } {
  const args = process.argv.slice(2)
  const i = args.indexOf("--tasks")
  if (i < 0 || !args[i + 1]) {
    console.error("ERROR: --tasks <path-to-tasks.json> required")
    process.exit(1)
  }
  const tasksPath = args[i + 1]
  const t = args.indexOf("--top")
  const top = t >= 0 && args[t + 1] ? Number(args[t + 1]) : 10
  return { tasksPath, top }
}

async function main(): Promise<void> {
  const { tasksPath, top } = parseArgs()
  if (!process.env.XDG_DATA_HOME) {
    console.error("ERROR: XDG_DATA_HOME must be set to point at a pinned bench state dir")
    process.exit(1)
  }

  // Strip BENCH_PREAMBLE the same way recallPlays does, so the embedded
  // query reflects the task-specific tail rather than the fixed preamble.
  const stripPreamble = (s: string): string => {
    const sep = s.lastIndexOf("\n---\n")
    return sep >= 0 ? s.slice(sep + 5).trim() : s
  }

  const tasksRaw = JSON.parse(fs.readFileSync(tasksPath, "utf8")) as Task[]
  console.error(`[probe] loaded ${tasksRaw.length} tasks from ${tasksPath}`)
  console.error(`[probe] XDG_DATA_HOME=${process.env.XDG_DATA_HOME}`)

  // Dynamic import AFTER env is set so xdg-basedir picks up XDG_DATA_HOME.
  const { initEmbedded, rawEmbeddedDb } = await import("../src/storage/db.embedded")
  const { zengramDb } = await import("../src/storage/db.zengram")
  const { runEmbeddedMigrations } = await import("../src/storage/zengram-migrate")
  const { Global } = await import("../src/global")

  const dataDir = path.join(Global.Path.data, "zeta")
  console.error(`[probe] resolved zeta data dir: ${dataDir}`)
  if (!fs.existsSync(dataDir)) {
    console.error(`ERROR: ${dataDir} does not exist — wrong XDG_DATA_HOME?`)
    process.exit(1)
  }

  initEmbedded(dataDir, "lsm")
  runEmbeddedMigrations(rawEmbeddedDb())
  const db = zengramDb()

  // Confirm the project the data was written under (there should be exactly
  // one when the pinned dir is from a single bench suite).
  const projects = await db.query<{ project_id: string }>(
    `SELECT DISTINCT project_id FROM knowledge WHERE scope = '/project' AND status = 'active'`,
  )
  if (projects.length === 0) {
    console.error("ERROR: no active /project facts in DB — wrong dir?")
    process.exit(1)
  }
  if (projects.length > 1) {
    console.error(`WARNING: ${projects.length} distinct project_ids in DB; using all`)
  }
  const projectId = projects[0].project_id

  const totalFacts = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM knowledge
     WHERE project_id = $1 AND scope = '/project' AND status = 'active' AND embedding IS NOT NULL`,
    [projectId],
  )
  console.error(`[probe] project_id=${projectId} active /project facts with embedding: ${totalFacts[0].n}`)

  const allDistances: number[] = []
  const perTask: Array<{
    task: string
    topK: Array<{ subject: string; distance: number }>
    total: number
    allDistances: number[]
  }> = []

  for (const t of tasksRaw) {
    const query = stripPreamble(t.problem_statement)
    const rows = await db.query<{ subject: string; distance: number | null }>(
      `SELECT subject, (embedding <-> embed($2)) AS distance
       FROM knowledge
       WHERE project_id = $1
         AND scope = '/project'
         AND status = 'active'
         AND embedding IS NOT NULL
       ORDER BY distance ASC`,
      [projectId, query],
    )
    const finite = rows.filter((r) => r.distance != null && Number.isFinite(r.distance)) as Array<{
      subject: string
      distance: number
    }>
    for (const r of finite) allDistances.push(r.distance)
    perTask.push({
      task: t.task_id,
      total: finite.length,
      topK: finite.slice(0, top),
      allDistances: finite.map((r) => r.distance),
    })
  }

  // Histogram across all (task, fact) pairs — buckets of 0.1 from 0 to 2.0.
  const buckets = new Array(20).fill(0)
  for (const d of allDistances) {
    const b = Math.min(19, Math.floor(d * 10))
    buckets[b]++
  }
  const total = allDistances.length

  console.log("")
  console.log("=== Distance histogram across all (task × fact) pairs ===")
  console.log(`Total pairs: ${total}  (= ${tasksRaw.length} tasks × ${totalFacts[0].n} facts)`)
  console.log("")
  console.log("range          count   pct   cumulative")
  let cum = 0
  for (let i = 0; i < 20; i++) {
    const lo = (i / 10).toFixed(1)
    const hi = ((i + 1) / 10).toFixed(1)
    cum += buckets[i]
    const pct = ((100 * buckets[i]) / total).toFixed(1)
    const cumPct = ((100 * cum) / total).toFixed(1)
    const bar = "#".repeat(Math.round((40 * buckets[i]) / total))
    console.log(`[${lo}, ${hi})    ${String(buckets[i]).padStart(6)}  ${pct.padStart(5)}%  ${cumPct.padStart(5)}%  ${bar}`)
  }

  console.log("")
  console.log("=== Per-task top-K nearest facts ===")
  for (const t of perTask) {
    console.log(`\n--- ${t.task} (n=${t.total}) ---`)
    for (const f of t.topK) {
      const subj = f.subject.length > 80 ? f.subject.slice(0, 77) + "..." : f.subject
      console.log(`  ${f.distance.toFixed(3)}  ${subj}`)
    }
  }

  // Summary stats per task — distance to the BEST fact, and the median fact.
  console.log("")
  console.log("=== Per-task summary (sorted by best-fact distance) ===")
  console.log("task                     best   p25    p50    p75    n")
  const summary = perTask.map((t) => {
    const all = t.allDistances // already sorted ascending
    if (all.length === 0) return { task: t.task, best: NaN, p25: NaN, p50: NaN, p75: NaN, n: 0 }
    const best = all[0]
    const p25 = all[Math.floor(all.length * 0.25)]
    const p50 = all[Math.floor(all.length * 0.5)]
    const p75 = all[Math.floor(all.length * 0.75)]
    return { task: t.task, best, p25, p50, p75, n: t.total }
  }).sort((a, b) => a.best - b.best)
  for (const s of summary) {
    console.log(
      `${s.task.padEnd(24)} ${s.best.toFixed(3)}  ${s.p25.toFixed(3)}  ${s.p50.toFixed(3)}  ${s.p75.toFixed(3)}  ${String(s.n).padStart(3)}`,
    )
  }

  // Cutoff projection — for each candidate gate, how many (task × fact) pairs survive.
  console.log("")
  console.log("=== Cutoff projection (kept pairs at each candidate threshold) ===")
  console.log("threshold   pairs_kept   pct    avg_per_task")
  for (const cutoff of [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85]) {
    const kept = allDistances.filter((d) => d <= cutoff).length
    const pct = ((100 * kept) / allDistances.length).toFixed(1)
    const avg = (kept / perTask.length).toFixed(1)
    console.log(`<= ${cutoff.toFixed(2)}      ${String(kept).padStart(6)}     ${pct.padStart(5)}%   ${avg}`)
  }
}

main().catch((e) => {
  console.error("probe failed:", e)
  process.exit(1)
})
