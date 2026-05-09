# Zeta secondary-index bug — non-deterministic `WHERE scope = …` reads

**Discovered:** 2026-05-09 while validating round 10 corpus cleanup
**Root cause found + fixed:** 2026-05-09 — race in `BTreeMvccStore::apply_batch`'s `par_iter()` when a single batch contains multiple writes to the same primary key (the Delete + Put pair every UPDATE emits for indexes whose columns didn't change). Last-writer-wins on the SkipMap insert was non-deterministic; when the Delete won, the live index entry was lost. Fixed by collapsing per-pk writes to the last entry, then parallelizing across distinct pks. Validated against round 10 DB: 5 fresh `bun` invocations now all return the true 32 /play rows.
**Workaround in opencode:** `scope LIKE` (no wildcard) bypasses the index — kept as belt-and-suspenders even after the fix.
**Impact:** every bench-time recallPlays call across all rounds operated on a random subset of plays per session. All historical "recall" measurements before the fix are confounded.

## Symptom

On the round 10 zengram dir
(`/home/gene/zengram-bench/results/multi-session-state/_suite_survey50_round10_zengram/opencode/zeta`):

| query | result across 5 fresh `db.open()` calls |
|---|---|
| `SELECT COUNT(*) FROM knowledge` | 105, 105, 105, 105, 105 ✓ |
| `WHERE status='active'` | 75, 75, 75, 75, 75 ✓ |
| `WHERE scope='/play'` | **17, 20, 22, 22, 24** ✗ |
| `WHERE scope='/project'` | **63, 65, 67, 68, 66** ✗ |
| `WHERE scope LIKE '/play'` (no wildcard) | 32, 32, 32, 32, 32 ✓ |
| `WHERE scope LIKE '/project'` (no wildcard) | 73, 73, 73, 73, 73 ✓ |

`scope_play + scope_project` via the equality-form ranges 80–90 and never sums to 105 (total). The LIKE form correctly sums to 105.

Within a single process, three back-to-back identical queries are stable. The non-determinism appears across separate process invocations — i.e. on each `db.open()`, the secondary index returns a different subset of matching rows.

## Reproduction (against the real DB)

```ts
import * as zetaDb from "zeta-db"
const db = zetaDb.open(
  "/home/gene/zengram-bench/results/multi-session-state/_suite_survey50_round10_zengram/opencode/zeta",
  "lsm",
)!
const eq = db.query<any>(`SELECT COUNT(*) AS n FROM knowledge WHERE scope='/play' AND status='active'`, []) as any[]
const lk = db.query<any>(`SELECT COUNT(*) AS n FROM knowledge WHERE scope LIKE '/play' AND status='active'`, []) as any[]
console.log(`= form: ${eq[0].n}    LIKE form: ${lk[0].n}`)
```

Run this in 5 separate `bun` invocations: `=` form varies 19–24, `LIKE` form is always 32.

## Reproduction on synthetic DB — NOT YET ACHIEVED

Built a synthetic DB with the same schema (id, scope, status, importance, time_created) plus the
`CREATE INDEX knowledge_scope_idx ON knowledge(scope, status, importance DESC)` and ran:
- 100 rows / 30 plays / 70 projects
- 30 status flips from separate processes
- 10 scope flips back-and-forth from separate processes
- Read after each phase

Counts stayed stable. The bug requires something specific to the round 10 DB's write history that we
have not yet captured: complex schema (multiple tables, embeddings, multiple indexes), long write
history with concurrent processes during the bench, repeated re-embed UPDATEs, possibly DDL
mutations.

## Direct diagnostic on round 10 DB

Diff'd `SELECT id WHERE scope='/play'` (uses index) against `SELECT id WHERE scope LIKE '/play'`
(forces scan, returns true 32 rows) across 5 fresh opens. Findings:

| missing-from-index frequency | row count |
|---|---|
| missing in **5/5** opens (deterministic) | 5 |
| missing in 4/5 | 1 |
| missing in 3/5 | 5 |
| missing in 2/5 | 3 |
| missing in 1/5 | 7 |
| **always present** (0/5) | **11** |
| **total /play rows** | **32** |

- The index never returns extra rows that don't belong — only undercounts. So the bug is
  *missing/dropped index entries*, not corrupt-pointed entries.
- The 5 always-missing rows are scattered across the insert timeline (ranks 8, 10, 17, 19, 21
  out of 32 ordered by `time_created`), interleaved with always-present rows. Rules out a
  simple "compaction boundary" theory.
- All rows have similar shape (importance ~0.79–0.80 after decay, all `status='active'`,
  `embedding IS NOT NULL`, `subject_len` 41–120). No obvious row-content discriminator between
  always-missing and always-present.
- `time_updated - time_created` is 28–46 billion μs (8–13 hours) for missing rows vs 8–18 billion
  μs (2–5 hours) for present rows — i.e. older inserts that received later UPDATEs are more
  likely missing. Cleanup-script UPDATEs from 2026-05-09 (subject rewrites, embedding refresh,
  similarity_hash backfill) all touched these rows, but none of the modified columns are in the
  scope index. So **UPDATEs that don't touch any indexed column appear to corrupt the secondary
  index for that row**.

This narrows the likely root cause to the UPDATE path's secondary-index maintenance: when a row
is rewritten (new MVCC version), Zeta should maintain the index entry pointing to the new
version. Either the new entry isn't always written, or the old entry's tombstone isn't always
applied, leaving inconsistent visibility per snapshot.

### Diagnostic primitive

To debug further, dump-and-diff the index vs scan IDs:

```ts
const indexedIds = new Set(db.query(`SELECT id FROM knowledge WHERE scope='/play'`).map(r=>r.id))
const truthyIds = new Set(db.query(`SELECT id FROM knowledge WHERE scope LIKE '/play'`).map(r=>r.id))
const missing = [...truthyIds].filter(id => !indexedIds.has(id))
```

Run from 5+ separate processes; missing-frequency histogram shows which rows are deterministic
vs stochastic.

## Mode is not the issue

Both `lsm` and `btree` storage modes exhibit the bug — the issue is in the secondary-index access
path, not the storage backend.

## Affected index

```sql
CREATE INDEX knowledge_scope_idx ON knowledge(scope, status, importance DESC);
```

Defined in `packages/opencode/src/storage/zengram-migrate.ts` as part of the knowledge schema. Used
by the planner for any `WHERE scope = '…'` predicate. Bypassed by `WHERE scope LIKE '…'` (which
forces a full scan that returns deterministic, correct results).

## Where in `~/zeta` to look

- `crates/zeta-server/src/iter_exec/operators.rs` — `build_index_scan_iter` (line ~1195) is the
  hot path for `IndexScan` plans; the lookup itself is unlikely to be the bug
- `crates/zeta-mvcc-store/src/lsm.rs` — `LsmMvccStore::open_with_cache_inner` opens 3 column
  families (Data, Index, Catalog); whatever recovers the Index CF on each open is suspect
- `crates/zeta-lsm/src/engine.rs:246-380` — `LsmEngine::open_inner` replays the manifest, scans
  for orphan files, starts background compaction; if this races with reads in a way that depends
  on filesystem timing, it would explain the cross-process variance
- `crates/zeta-tso/src/lib.rs` — TSO state in `tso/tso_epoch.bin`; if read snapshot timestamps
  vary per open, MVCC visibility would shift across opens

The symptom that `total` and `WHERE status='…'` (full-scan paths) are stable while the indexed
`WHERE scope='…'` is flaky points at:
1. Index data persisted incompletely (some entries missing for the row's MVCC version that wins
   the visibility check)
2. Recovery / version-edit replay ordering producing different "Version" snapshots for the Index CF
3. MVCC GC removing index entries before all corresponding base-table tombstones are gone

## Workaround in opencode

PR converts three `scope = $N` predicates to `scope LIKE $N` (no wildcard, semantically equivalent
match):

- `learnFact` dedup (line ~163)
- `purgeReasoningNoise` (line ~602)
- `recallPlays` (line ~1241)

`recallFacts` already used `LIKE '/scope%'` for a different reason (scope-prefix matching), so it
was incidentally already on the safe path. Tests still pass; the workaround only changes which
access path the planner picks.

## What this invalidates

Every prior measurement that depended on `WHERE scope='/play'` or `WHERE scope='/project'` reads
was a random sample of the true rowset. In particular:
- Bench-time `recallPlays` returned a random subset of plays per opencode subprocess
- The "1% inject rate" finding from round 10 was on a random subset of the corpus
- Cross-round corpus comparisons (round 7 vs round 9 vs round 10) cannot be trusted

The cleanup work in this session (purge regex, play-subject strip, content-hash dedup, per-turn
LLM-extractor cut) is still correct as code; the round 10 corpus state we measured is not.

## Root cause and fix (2026-05-09)

The bug was in `~/zeta/crates/zeta-mvcc-store/src/btree.rs::apply_batch`. The
function used `batch.writes.par_iter().try_for_each(...)` with the comment
*"Conflict detection guarantees each key appears at most once per batch."* —
which is true for INSERT and DELETE, but **false for UPDATE**.

`exec_update` emits, for every secondary index, a Delete followed by a Put of
the (possibly identical) idx_key — even when no indexed column actually
changed. The two writes share the same primary key. Under parallel apply:

1. Both writes called `memtable.get(pk)` and read the same pre-batch state.
2. Both called `epoch_mgr.append_version(...)` — duplicate chain entries.
3. Both called `memtable.put(cf_idx, pk, new_record)` on the SkipMap. The
   SkipMap entry for `pk` ended up with whichever record-build finished last.
4. When the Delete record won, the row was logically tombstoned and the
   secondary-index scan dropped it on read.

Across `db.open()` boundaries the bug surfaced as a *moving* missing set
because rayon's work-stealing scheduler picks the winner non-deterministically
each time the LogApplier replays UPDATE log entries (the LSM-backed mode
encodes both writes with distinct seqs and wins via seq-dedup, so it was
correct — only btree mode hit the bug).

**Fix:** dedup the writes by primary key before the parallel pass, keeping
only the last write per pk (matches the WriteBuffer order: index_deletes →
data_put → index_puts, so the Put wins as intended). After dedup, every
remaining write targets a distinct pk and parallel apply is race-free.

Patch: `crates/zeta-mvcc-store/src/btree.rs::apply_batch` —
[~/zeta diff](#) (uncommitted).
Tests: `delete_then_put_same_pk_in_batch_is_deterministic` (200 trials,
single-pk) and `delete_then_put_many_pks_in_batch` (50 pks per batch) — both
fail on the original `par_iter()` path and pass after the dedup.

## Next steps

1. ~~Patch `~/zeta` and rebuild NAPI~~ — done.
2. ~~Decide whether to revert the `scope LIKE` workaround~~ — reverted
   2026-05-09. Three sites (`learnFact` dedup, `purgeReasoningNoise`,
   `recallPlays`) flipped back to `scope = $`. Four `recallFacts` sites left
   alone — those bind `${scope}%` for genuine prefix matching.
3. ~~Re-run the round 10 cleanup probe~~ — done. 5 fresh subprocess opens
   against the round 10 DB all return identical counts: total=105,
   active=75, scope=/play=32 (matches LIKE), scope=/project=43 (matches
   LIKE), reflection=39, extracted=36. Sums consistent.
4. Re-launch a bench round — first cleanly-measurable result since the
   round-2-through-9 scorer-cache invalidation.
5. Land the `~/zeta` change upstream / commit it — done as
   [~/zeta#979](https://github.com/genezhang/zeta/pull/979). Will need to
   bump the embedded artifact `~/zeta-embedded/.../libzeta_embed.a` once a
   `zeta-embedded-v*` tag triggers the build-embedded CI workflow.
   Follow-up issue [~/zeta#981](https://github.com/genezhang/zeta/issues/981)
   covers a correctness-neutral LSM-side write-amp optimization spun off
   from the PR review.

## Side issue surfaced during the post-fix probe

`zeta-db.open()` called twice in the same process against the same data
directory returns a Database instance whose `query` / `execute` methods are
`undefined` on the second call (own keys empty, prototype shows the methods
present, but member access yields `undefined`). The first instance works
correctly. Workaround used by the round 10 probe: spawn a fresh subprocess
per trial. Worth a follow-up — could be a NAPI ref-counting issue or a
Database-finalizer reuse bug. Not blocking for the round 10 probe or for
production opencode (which only opens once per process via
`initEmbedded`).
