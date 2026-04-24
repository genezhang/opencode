# Zengram Elevation Plan

Living doc. Captures the levers we've considered for making `opencode + Zengram`
hit the mission goal from `CLAUDE.md`: **fewer turns, fewer tokens, match or
beat the SQLite baseline on quality.** Update this doc every time we ship an
elevation or rule something out.

---

## Status snapshot (post-2026-04-23)

| axis | 2026-04-09 zengram (pre-fix) | after #11/#12/#13 | **after #15 (plays)** | baseline (SQLite) |
|---|---|---|---|---|
| dj-11740 prompt tokens | 80,388 | 26,436 | **14,308** (rep 2) | 31,229 |
| dj-11740 turns | 31 | 30 | **16** (rep 2) | 30 |
| dj-11740 duration | 206 s | 100 s | **123 s** (rep 2) | ≈170 s |
| completion rate | 100% | 100% | 100% | 100% |

**Result so far:** we closed the cost overhead with #11-#13 (Zengram cheaper
than the SQLite baseline on fresh sessions). Then #15 (play recall) delivered
the compounding-value promise: by rep 2 of a 3-rep multi-session run,
Zengram's accumulated state lets the model solve the identical task in **16
turns instead of 30** — a 47% turn reduction vs yesterday's B1 baseline.

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

**B1. Multi-session bench methodology.** ✅ **Validated with plays (2026-04-24).** Harness landed in zengram-bench#1. First experiment without plays (2026-04-23) didn't show the thesis: reps 1 & 2 hit the 30-turn cap. Re-run after #15 (play recall) showed clear compounding: 26 → 26 → **16 turns** across 3 reps, vs 26 → 30 → 30 without plays. Conclusion: persistent state is necessary but not sufficient — what's recalled has to be *file-anchored and task-matched* to shortcut exploration. Facts alone don't; plays do.

**B2. Semantic fact recall via embeddings.** ✅ **Already active** — verified 2026-04-23. `recallFacts` takes `context` (set to the last user-message text in `prompt.ts:1512`) and runs the embedding-ranked query first (`knowledge/index.ts:125-139`). Spot-checked the dj-11740 probe state: 14 knowledge rows all stored with non-null embeddings, no embed-related errors in the log, and recalled facts were semantically relevant (Django-migration topics for a Django-migration task). Keep this lever here in case we later want to tune the 0.7/0.3 cosine-vs-importance blend.

**B3. "Files to start with" injection.** ✅ **Shipped as part of #15 (plays).** Plays record problem+files-touched and recall by embedding similarity. Measured on dj-11740: rep 2 with 2 prior plays → **16 turns** (vs 30 without). Turn reduction: 47%. Followup: tune the recall threshold once we have more tasks (currently top-3, no min-similarity filter).

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
