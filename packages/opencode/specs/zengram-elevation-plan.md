# Zengram Elevation Plan

Living doc. Captures the levers we've considered for making `opencode + Zengram`
hit the mission goal from `CLAUDE.md`: **fewer turns, fewer tokens, match or
beat the SQLite baseline on quality.** Update this doc every time we ship an
elevation or rule something out.

---

## Status snapshot — 2026-05-03 (first end-to-end with the trajectory analyzer live)

First survey since the trajectory minimizer + analyzer (zengram-bench PR #3) and the play recall pipeline (PR #19) landed. 25-task Django subset × n=1 × 2 variants = 50 invocations, multi-session BENCH_SUITE_NAME=survey25_round1 so plays compound across the suite.

**Headline (analyzer output, both n=25):**

| metric | baseline | zengram | Δ |
|---|---|---|---|
| Resolved | 1/25 (4%) | **3/25 (12%)** | **3×** |
| Total tokens | 2.28 M | 2.82 M | +24% |
| **Resolved / 1M tok ★** | **0.44** | **1.06** | **+141% (~2.4×)** |
| Median tokens / run | 64 k | 92 k | +43% |
| Median turns / run | 15.0 | 12.0 | -3 |

The token-efficiency gap *widened* from the focused 3-task suite (1.7× → 2.4×) — plays compound more at scale.

### Asymmetric-burn pattern (the analyzer's killer feature)

Per-task token deltas surface exactly what's working and what isn't. Both variants fail to resolve, but zengram is **dramatically cheaper** on tasks where plays anchor to the right files:

| task | baseline tok | zengram tok | turns Δ |
|---|---|---|---|
| dj-12713 | 155 k | 105 k | 10 → 6 |
| dj-14559 | 81 k | 55 k | 11 → 6 |
| dj-14787 | 144 k | 61 k | 11 → 7 |
| dj-16333 | 83 k | 55 k | 15 → 10 |

…and **dramatically more expensive** when cross-domain plays mislead:

| task | baseline tok | zengram tok |
|---|---|---|
| dj-13297 | 33 k | 158 k |
| dj-15368 | 50 k | 134 k |
| dj-16595 | 78 k | 274 k (3.5×) |

The right-tail wins outweigh the left-tail blowups (hence the 2.4× headline), but the left tail is real cost. Tightening the similarity gate (currently `ZENGRAM_PLAY_MAX_DISTANCE=0.5`) is the obvious next investigation.

### Wasted-action distribution

| tag | baseline | zengram |
|---|---|---|
| useful | 79.3% | 82.8% |
| **redundant_read** | **20.3%** | **17.2%** |
| premature_test | 0% | 0% |
| lint_only | 0% | 0% |
| error_retry | 0.3% | 0% |

At suite scale zengram has *fewer* redundant reads than baseline — flipped from the focused-suite finding. Plays surface the right files often enough that the model doesn't need to re-discover them. (Note: the parser currently lacks read offset/limit so chunked re-reads are conflated; tracked as zengram-bench issue #4.)

`no_edit` sessions: 14 baseline, 10 zengram — both have many "give up empty-handed" sessions on the harder tasks; zengram cuts ~30%.

### Caveat: absolute numbers ≠ 2026-04-29 numbers

The 2026-04-29 snapshot below reported 8/25 baseline, 13/25 zengram on the same subset; this run got 1/25, 3/25. Difference is the model: 2026-04-29 used `Qwen3-Coder-30B-A3B-Instruct`, this run used `Qwen3-Coder-Next-UD-Q6_K_XL`. The Next variant appears notably less capable on this benchmark despite the name suggesting otherwise. The *ratio* (2.4×) and the per-task pattern are the load-bearing signal; absolute resolution rate isn't directly comparable across model swaps.

### What this enables

The trajectory analyzer turning real signal into per-task asymmetry data is the missing piece for tuning the play pipeline empirically rather than by gut. Next investigations the data points at:

1. Tighter similarity gate (or per-task gate). The dj-16595 3.5× blowup is exactly what `ZENGRAM_PLAY_MAX_DISTANCE` is supposed to prevent.
2. Migrate the trajectory parser into opencode's `run` command (zengram-bench issue #4) so it sees read offset/limit and can distinguish chunked re-reads from literal re-reads.
3. Re-run on `Qwen3-Coder-30B-A3B` for direct comparison with the 2026-04-29 numbers — n=1 × 25 tasks is small enough that 1 vs 3 resolved is high variance; bigger n on a more capable model would settle whether the absolute drop is model-quality or a regression we're missing.

---

## Status snapshot — 2026-04-29 (multi-task suite, local-LLM bench, **mission goal hit**)

**Headline: Zengram now wins on every axis we care about** — more tasks resolved, fewer tokens per resolved task, and recall actually compounds across reps. First defensible numbers showing practice matches theory.

**Setup:** Qwen3-Coder-Next Q6_K_XL on local llama.cpp (RDNA 3.5 iGPU, AMD Ryzen AI Max+ 395, 128 GB shared LPDDR5X), n_ctx=65536, t=0.1, top_p=0.8, BENCH_MAX_TURNS=15. 3-task suite (dj-12713 admin/options, dj-14089 utils/datastructures, dj-15127 messages/storage), interleaved BENCH_SUITE_NAME so plays cross-pollinate, n=5 reps each variant.

| metric | baseline (n=15) | zengram (n=15) | delta |
|---|---|---|---|
| **Resolved** | 11/15 | **14/15** | **+27%** |
| Total tokens | 1.64 M | 1.52 M | -7% |
| **Tokens / resolved** | 149 294 | **108 699** | **-27%** |
| **Turns / resolved** | 13.2 | **9.0** | **-32%** |

**Per-task breakdown:**
| task | baseline | zengram | notable |
|---|---|---|---|
| dj-12713 (hard, solvable) | 9.6 turns / 136K / 5/5 | 7.2 / 96K / 4/5 | recall cuts turns ~25%; one zengram seed-rep didn't commit |
| dj-14089 (easy) | 4.4 / 43K / 5/5 | 4.6 / 47K / 5/5 | parity — gate correctly drops cross-task plays |
| **dj-15127 (was unsolvable)** | 15.0 / 149K / **1/5** | 13.4 / 161K / **5/5** | **once one zengram rep landed a fix, every subsequent rep replayed it** |

The dj-15127 row is the smoking gun: baseline 1/5 (one lucky run), zengram 5/5. The first zengram solve produced a play with the diff snippet; every later rep recalled it and re-applied the equivalent edit instead of re-discovering from scratch.

### How recall finally landed (the engineering story)

Each item below was a real bug or design hole that gated a measurable improvement. All shipped between 2026-04-27 and 2026-04-29.

1. **Within-session prefix stability** — `recallPlays` ran every turn, so its block could mutate turn-to-turn (different rank ordering of equally-similar plays) and break llama.cpp's prefix KV cache. Memoized once per `excludeSessionId` so the block stays byte-stable inside a session.
2. **Compact play format** — Original 500-byte plays carried "Steps that worked: grep → read → edit" narrative + deep-read file list. Tighter format (file + diff snippet) drops ~70% of bytes; the model never used the narrative anyway.
3. **Race-free edit extraction** — `buildEditChanges` queried `tool_call`, but that table is projected from a separate event and didn't always commit before recordPlay queried it on short sessions. Switched to `part` table (synchronously written) so plays reliably contain diff content even when sessions are short.
4. **Bigger play preview** — `EDIT_PREVIEW_MAX` 200 → 600 chars. The model needs to see the *change* (e.g. an `if 'widget' not in kwargs:` wrap), not just the function header. 200-char truncation cut before the meaningful line.
5. **`tool_id IN (...)` workaround** — Zeta returned 0 rows for `WHERE tool_id IN ('edit','multiedit','write')` while the same query without the IN clause returned all rows. Removed the IN filter and dedupe in JS instead.
6. **Bench wrapper plumbed cache_read** — Added `cache_read_tokens` and `turns_with_cache_hit` through wrapper → usage.json → harness → result.json. Made cache regressions instantly visible (would have caught the v6 regression on first inspection).
7. **Suite-level pinned dir** — `BENCH_SUITE_NAME=...` collapses all tasks in a sweep into one zengram state directory; without it, each task's plays were isolated and recall could never cross task boundaries.
8. **Embedding-poisoning fix (the unlock)** — `recallPlays` was embedding the *full* user message including a 1.5KB BENCH_PREAMBLE. The preamble dominated the embedding so all queries embedded similarly regardless of task. Strip everything before the last `\n---\n` separator before embedding the query — same-task plays jumped from distance ~0.61 to ~0.1, cross-task plays moved from ~0.61 to ~0.87. The 0.5 gate now cleanly separates "relevant" from "noise."
9. **Similarity-gated injection** — `ZENGRAM_PLAY_MAX_DISTANCE=0.5` (env-tunable). Only inject plays whose L2 distance to the current query is under threshold. Cross-task admin plays no longer pollute OrderedSet recall.
10. **Strong "play is hint, must edit" preamble rule** — Without rule 8 ("the play describes PRIOR sessions; current checkout is unmodified; you MUST call edit/write yourself"), the model occasionally treated a same-task play as evidence the file was already fixed and stopped without editing. Quality preserved at 6/6 only after this rule landed.
11. **Early-quit directive** — Rule 9 ("if after ~8 turns you can't identify a fix, write 'I cannot determine a fix' and stop"). Surfaces the `resolved/tokens` metric: failing fast on impossible tasks is a productivity win even when the count of resolved doesn't change. The simpler one-condition phrasing won out over a 3-precondition variant we tried (which over-engineered the rule and disabled early-quit by accident).

### Scaled-up sanity: 25-task survey (n=1)

Run on 2026-04-29: same 25-task `tasks/django_subset.txt`, **single shared zengram dir** simulating "same dev, same repo, plays compound across tasks." n=1 per task per variant, 50 runs.

| metric | baseline (n=25) | zengram (n=25) |
|---|---|---|
| **Resolved** | 8/25 (32%) | **13/25 (52%)** |
| **Tokens / resolved** | 300 074 | **247 504** (-18%) |
| **Turns / resolved** | 36.6 | **22.5** (-39%) |

**Strict superset on resolution: zengram solves every task baseline solves, plus 5 more** (dj-10097, dj-11999, dj-12713, dj-16333, dj-16877). Baseline solved zero that zengram didn't.

**Cross-task tax surfaces at scale.** Some tasks (dj-12273, dj-15561, dj-15127) cost 2-3× more tokens on the zengram side because the gate is sometimes too generous and the rendered plays-block grows as the suite progresses. With 25 tasks of plays accumulated, even gated-down recall is bigger than the n=3 trio's recall. Open work item: tighter gate, hash-stable ordering, or per-task play limit to keep the block compact at scale.

### Apples-to-apples vs the 2026-04 baseline

The 2026-04-09 bench note (recorded in `memory/project_zengram_bench_2026_04.md`) had Zengram at **1.85× tokens, +9% turns**, no quality gain — the regression that triggered this whole effort. Today's headline:

| | 2026-04-09 zengram | 2026-04-29 zengram |
|---|---|---|
| tokens vs baseline | **+85%** | **-7%** total, **-27% per resolved** |
| turns vs baseline | +9% | -13% total, -32% per resolved |
| resolved vs baseline | parity | **+27%** |

Different model and task pool, but the direction inverted: from "Zengram is worse on every axis" to "Zengram is better on every axis."

---

## Status snapshot (post-2026-04-24, late night — recall pipeline now live)

**This section was corrected three times while embed() was dead. As of
2026-04-24 late, embed() works end-to-end.** See the "invalidated results"
note at the bottom of this section for history.

| axis | 2026-04-09 zengram (pre-fix) | after #11/#12/#13 (solo, verified fork) | after #15+#18 (plays, multi-session, variance) |
|---|---|---|---|
| dj-11740 prompt tokens (rep 0) | 80,388 | 26,436 | ~77,464 |
| dj-11740 turns (rep 0) | 31 | 30 | 21 |
| dj-11740 turns (rep 2) | 31 (isolated) | — | 15 |
| completion rate | 100% | 100% | 100% |

**Honest interpretation (pre-2026-04-24 embed fix):** every "validation"
before today was stale-upstream variance or fork-variance-with-broken-recall.
The rep 2 turn drop (21 → 15) sat inside dj-11740's n=1 variance band
(2026-04-09 isolated reps: 12, 30, 31), and the recall pipeline's semantic
path was silently dead — no play ever surfaced to the model during a bench
run. That substrate is now working and the thesis is re-testable.

### How recall got unblocked (2026-04-24)

1. **Zeta JOIN projection is normal SQL.** `SELECT p.data FROM part p JOIN
   turn t ON …` returns keys `"p.data"` (alias-qualified), which is standard
   behaviour — not a bug. Unqualified `SELECT data` and `SELECT p.data AS
   data` both return bare `data`. The two-query workaround in `recordPlay`
   still works but could be collapsed to a single JOIN with `AS`-aliased
   columns if we want to simplify.
2. **Zeta `embed()` now produces real vectors.** The upstream `embed()`
   function was in the new `libzeta_embed.a` all along, but three pieces
   were missing to reach it from Node:
   - fork `crates/zeta-embedded/src/lib.rs` did not declare
     `extern "C" fn zeta_use_local_embed` or a `ZetaDbSync::use_local_embed`
     method — added, gated on `#[cfg(feature = "local-embed")]`.
   - NAPI binding (`bindings/node/src/lib.rs`) did not expose the provider
     registration — added `Database.useLocalEmbed(modelDir)`, plus a
     `local-embed` Cargo feature in `bindings/node/Cargo.toml` that forwards
     to `zeta-embedded/local-embed` and produces a ~37 MB `.node` (vs ~15 MB
     with `libzeta.a` only).
   - opencode's `initEmbedded()` did not call the provider — added
     `registerLocalEmbed(db)` that runs at startup, reads
     `OPENCODE_EMBED_MODEL_DIR` (or defaults to `~/embed/`), feature-detects
     `typeof db.useLocalEmbed === "function"`, and logs (non-fatal) if the
     binding isn't the local-embed build.
3. **Smoke:** `SELECT embed('x')` returns a 384-dim vector, `UPDATE
   knowledge SET embedding = embed(subject || '. ' || content)` populates
   every row, and `ORDER BY cosine_distance(embedding, embed($1))` ranks
   semantically (auth query hits auth row ahead of numpy row).

### Invalidated results (kept for history)

- **"26 → 16 turns" (2026-04-23):** ran against the stale upstream opencode,
  not our fork. `run-zengram.sh` defaulted `OPENCODE_ZENGRAM_BIN` to PATH's
  `opencode`. Fixed in zengram-bench#2.
- **"30 → 30 → 19 turns" (2026-04-24 morning, honest re-run against fork):**
  hit the JOIN bug (#18) and embed() NULL bug (#18-upstream), so `recordPlay`
  never wrote rows and recall was never attempted. The 19-turn outcome was
  pure task variance.
- **"21 → 21 → 15 turns" (2026-04-24 late night, post-#18):** plays persist
  but embeddings stay NULL → `recallPlays` returned empty on every logged
  turn (verified: `plays=0` on all context.sizes lines). Still variance.

### Fixes that got us here
- [#11](https://github.com/genezhang/opencode/pull/11) — JSONB string decode on `part.data`. Sessions couldn't complete a single real turn before this.
- [#12](https://github.com/genezhang/opencode/pull/12) — `ToolPart` projector field names + `extractAndLearn` JSONB decode. Every tool_call row had `tool_id="unknown"`/`state="pending"`; `workspace_file` never populated; recallFacts ran on JSON scaffolding.
- [#13](https://github.com/genezhang/opencode/pull/13) — Collapse stable system prefix into one cache-friendly message. Ws-change turns went from 5% cache hit to 89-100%.
- [#15](https://github.com/genezhang/opencode/pull/15) — Play recall: record problem+files-touched per session, recall by embedding similarity, inject as `<zengram-previously-helpful>` with explicit "read these first" framing. First measurable turn reduction from accumulated Zengram state.
- [#8](https://github.com/genezhang/opencode/pull/8) — Instrumentation (`OPENCODE_LOG_CONTEXT_SIZES`). How we found all of the above.

---

## Levers

### A. Cost-side (more token reductions)

**A1. Dynamic fact count per turn.** Today `recallFacts(limit=20)` always runs. Short tool-call turns don't need 500 tokens of recalled facts; planning turns might want more. Drive the limit from the user message's length / type (e.g. LLM quick-categorize or heuristic). **Expected:** avg inject drops 50-70%, meaningful cache wins on short-turn-heavy sessions. **Effort:** small.

**A2. Zengram summaries in compaction.** `SessionSummary` today is a generic title-style summary. Replace it (or augment) with Zengram's extracted facts + workspace snapshot for this session when the model crosses the compaction threshold. **Expected:** huge on long sessions (30+ turns) — instead of re-sending 15k of prose summary, send 1-2k of structured recall. **Effort:** medium.

**A3. Cache breakpoint #2 stabilization.** `provider/transform.ts::applyCaching` currently tags `slice(0, 2)` system messages. Second breakpoint lands on the Zengram block, which is dynamic — so it invalidates on every change. Either don't tag the dynamic message, or move breakpoint #2 to stable conversation history. **Expected:** removes the residual periodic cache busts (outside TTL expirations). **Effort:** small.

**A4. Dedupe facts across turns in one session.** Today `recallFacts` can return the same fact on successive turns. The model already read it turn N; re-sending is wasted. Track "injected this turn" set per session, subtract from next turn's recall. **Expected:** modest within-session savings on long sessions. **Effort:** small.

---

### B. Turns-side (the harder, higher-value direction)

**B1. Multi-session bench methodology.** Harness landed (zengram-bench#1). Previous "validation" runs (26/26/16, 30/30/19, 21/21/15 across 2026-04-23/24) were all variance (wrong binary / broken recordPlay / NULL embeddings). With embed() live as of 2026-04-24 late, the thesis is finally testable end-to-end. **Next:** rerun the 3-rep bench and look for a rep-2 turn-count drop outside dj-11740's 12–31 natural variance band.

**B2. Semantic fact recall via embeddings.** Runtime unblocked 2026-04-24. `recallFacts` and `recallPlays` now hit the vector similarity branch — `embed()` returns real 384-dim bge-small-en-v1.5 vectors via the in-process ONNX runtime linked into `libzeta_embed.a`. The keyword/importance fallback in `recallFacts` remains as the second branch for rows that somehow missed embedding.

**B3. "Files to start with" injection.** Code shipped (#15 + #18); runtime now live. Every successful session's problem+files gets an embedding; next session's `recallPlays` can find it by cosine distance. **Next:** 3-rep multi-session bench and look for a genuine turn-count drop on rep 2 — that's the real thesis test, finally measurable.

**B4. Extracted "plays."** On successful completion, Zengram extracts the tool-call path that worked (`read → grep → edit → test`) and stores it as a reusable sketch keyed by task signature. On similar future tasks, inject "here's what worked last time." **Expected:** large if it works — but needs prompt engineering and quality-filtering. **Effort:** large.

**B5. LLM-judged fact-quality audit.** Sample 50+ extracted facts from real sessions, rate them useful/noisy, prune the `extractFacts` heuristics that produce noise. Then re-run the audit. **Expected:** better signal-to-noise in the recall block; may also shrink the average block size. **Effort:** medium (offline, but LLM-gated).

**B6. Prompt-level guidance.** ✅ **Shipped with #15** — the `<zengram-previously-helpful>` header reads *"Read these files first before broad exploration — the problem domain overlaps."* This framing is baked into `formatPlaysBlock`, so every recall includes the directive. Consider extending similar framing to `<zengram-knowledge>` if the fact-quality audit (B5) shows recalled facts are useful.

---

### C. Measurement infrastructure

**C1. Bench CI gate.** Run a 2-task × 1-trial A/B on every PR touching prompt construction or Zengram injection. Regress automatically if dj-11740 degrades >10% tokens or +2 turns. **Expected:** prevents silent regressions like #11/#12 from shipping undetected. **Effort:** medium.

**C2. Per-turn tool-call latency logging.** Instrumentation already logs block sizes; add wall-clock per tool call so we can see which tool sequences dominate session duration. **Expected:** visibility for future "fewer turns" optimizations. **Effort:** small.

**C3. "Replay last N sessions" bench mode.** Dump recent real sessions to JSONL (user message + ideal outcome), replay through the fork to measure regression on real traffic rather than SWE-bench proxy. **Expected:** real-user quality signal, not just SWE-bench. **Effort:** large (requires session export + anonymization).

---

## Ruled out / deferred

- **"Just add persistent state and turns will drop"** (implicit assumption behind B1). First multi-session experiment (2026-04-23, dj-11740, 3 reps, facts-only) invalidated it: accumulated Zengram state did not reduce turn count. Persistent state is *necessary* but not *sufficient* — what's recalled has to be actionable. Re-tested 2026-04-24 with plays (#15): turn count dropped 30 → 16 by rep 2. Conclusion refined: **persistent state + file-anchored recall = compounding win**; generic facts alone don't move the needle.

---

## Next round picks

The doc is pre-populated so we don't rebuild context from scratch. When the
next elevation cycle starts:

1. Check `status snapshot` — is the gap still turn count, token count, or quality?
2. Pick from A / B / C that matches the current bottleneck.
3. Each merged lever should update this doc with before/after numbers.

### Open after 2026-04-29

- **Methodology fix: stop measuring same-task-repeated.** Running n=3 reps consecutively per (task, variant) inflates zengram's apparent win because rep 1+ recalls a near-identical play from rep 0. Real-world devs don't solve the same bug 3 times in a row. Better design: a *warmup* zengram-only pass through all tasks (plays accumulate, no measurement), then a *measurement* pass with a different shuffle. Compares zengram-with-warmed-state vs fresh baseline on 1-shot-per-task. This is what we should be measuring; the trio/n=5 numbers are real but unrealistic.
- **Steel-man baseline: single long opencode session w/ compaction.** The current bench wraps each task as an independent `opencode run` — fresh session, no memory. Opencode does have native cross-session memory via summary/compaction when used through the API server (`opencode serve`). To honestly test "does Zengram beat opencode's native long-context memory," the baseline path would need to keep one opencode process alive across all tasks and let summarization handle context. Bigger bench-architecture change; flagged as future work.
- **Cross-task overhead at scale.** With 13+ tasks accumulating plays, the rendered recall block grows even with the 0.5 gate. Per-task play limit (cap at 1-2 plays per query) or hash-stable rendering would keep the block compact as the suite grows.
- **Cross-session prefix stability.** Plays render order drifts as the play set grows; same-task reps can still re-pay prompt-processing cost when the rendered block changes byte-for-byte across sessions. Hash-stable ordering would close this.
- **Hang diagnosis.** Bench has had 4-5 multi-hour hangs in this cycle (orphaned opencode subprocesses after wrapper-shell SIGTERM). Doesn't affect zengram's logic but ruins long sweeps. Worth tracking down.
