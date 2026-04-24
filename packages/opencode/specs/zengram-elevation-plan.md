# Zengram Elevation Plan

Living doc. Captures the levers we've considered for making `opencode + Zengram`
hit the mission goal from `CLAUDE.md`: **fewer turns, fewer tokens, match or
beat the SQLite baseline on quality.** Update this doc every time we ship an
elevation or rule something out.

---

## Status snapshot (post-2026-04-23)

| axis | 2026-04-09 zengram (pre-fix) | today (post-#11/#12/#13) | baseline (SQLite) |
|---|---|---|---|
| dj-11740 prompt tokens | 80,388 | **26,436** | 31,229 |
| dj-11740 turns | 31 | 30 | 30 |
| dj-11740 duration | 206 s | **100 s** | ≈170 s |
| completion rate | 100% | 100% | 100% |

**Result so far:** we closed the cost overhead. Zengram is now **cheaper than
the SQLite baseline** on dj-11740. Turn count is flat, so the promised
turn-reduction from persistent memory hasn't materialized yet — that is the
next frontier.

### Fixes that got us here
- [#11](https://github.com/genezhang/opencode/pull/11) — JSONB string decode on `part.data`. Sessions couldn't complete a single real turn before this.
- [#12](https://github.com/genezhang/opencode/pull/12) — `ToolPart` projector field names + `extractAndLearn` JSONB decode. Every tool_call row had `tool_id="unknown"`/`state="pending"`; `workspace_file` never populated; recallFacts ran on JSON scaffolding.
- [#13](https://github.com/genezhang/opencode/pull/13) — Collapse stable system prefix into one cache-friendly message. Ws-change turns went from 5% cache hit to 89-100%.
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

**B1. Multi-session bench methodology.** ← RECOMMENDED NEXT. The current bench runs each task *once*, fresh. Zengram's value is compounding across sessions. Extend `zengram-bench` to run the same task 3× in sequence with persistent Zengram state, measure turn count of runs 2 and 3. If runs 2/3 complete in fewer turns than run 1, Zengram's thesis is validated. **Expected:** shows (or disproves) whether all our downstream work will pay off. **Effort:** small (harness change + a cross-session storage hook).

**B2. Semantic fact recall via embeddings.** ← RECOMMENDED NEXT. `embed()` is already wired server-side (`knowledge/index.ts:recallFacts` line 128 already has a `context`-path branch). Default the `context` input to the current user-message text and put the embedding-ranked query first, fall back to importance-ranked only when the embedding branch returns nothing. **Expected:** relevant facts at top of block → actually actionable signal. **Effort:** small (SQL change).

**B3. "Files to start with" injection.** Use cross-session `workspace_file` history, keyed by project + problem-statement similarity, to pre-suggest files the agent should read first. Current workspace-block only shows files touched *this* session, so it's useless on the first few turns. **Expected:** 3-5 fewer exploration turns per task if it works. **Effort:** medium (ranking logic + fresh-session injection).

**B4. Extracted "plays."** On successful completion, Zengram extracts the tool-call path that worked (`read → grep → edit → test`) and stores it as a reusable sketch keyed by task signature. On similar future tasks, inject "here's what worked last time." **Expected:** large if it works — but needs prompt engineering and quality-filtering. **Effort:** large.

**B5. LLM-judged fact-quality audit.** Sample 50+ extracted facts from real sessions, rate them useful/noisy, prune the `extractFacts` heuristics that produce noise. Then re-run the audit. **Expected:** better signal-to-noise in the recall block; may also shrink the average block size. **Effort:** medium (offline, but LLM-gated).

**B6. Prompt-level guidance.** Add a short system-prompt line telling the model how to use the Zengram recall block (e.g. "Treat the `<zengram-knowledge>` block as hints from prior successful sessions — prefer following its suggested files/approach over re-discovering"). **Expected:** modest; the model may already do this, but explicit guidance removes ambiguity. **Effort:** trivial.

---

### C. Measurement infrastructure

**C1. Bench CI gate.** Run a 2-task × 1-trial A/B on every PR touching prompt construction or Zengram injection. Regress automatically if dj-11740 degrades >10% tokens or +2 turns. **Expected:** prevents silent regressions like #11/#12 from shipping undetected. **Effort:** medium.

**C2. Per-turn tool-call latency logging.** Instrumentation already logs block sizes; add wall-clock per tool call so we can see which tool sequences dominate session duration. **Expected:** visibility for future "fewer turns" optimizations. **Effort:** small.

**C3. "Replay last N sessions" bench mode.** Dump recent real sessions to JSONL (user message + ideal outcome), replay through the fork to measure regression on real traffic rather than SWE-bench proxy. **Expected:** real-user quality signal, not just SWE-bench. **Effort:** large (requires session export + anonymization).

---

## Ruled out / deferred

*(none yet — populate as we rule things out)*

---

## Next round picks

The doc is pre-populated so we don't rebuild context from scratch. When the
next elevation cycle starts:

1. Check `status snapshot` — is the gap still turn count, token count, or quality?
2. Pick from A / B / C that matches the current bottleneck.
3. Each merged lever should update this doc with before/after numbers.
