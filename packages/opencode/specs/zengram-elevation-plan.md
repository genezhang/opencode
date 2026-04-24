# Zengram Elevation Plan

Living doc. Captures the levers we've considered for making `opencode + Zengram`
hit the mission goal from `CLAUDE.md`: **fewer turns, fewer tokens, match or
beat the SQLite baseline on quality.** Update this doc every time we ship an
elevation or rule something out.

---

## Status snapshot (post-2026-04-24, late night)

**This section has been corrected twice. Current honest state follows.** See
the "invalidated results" note at the bottom of this section for history.

| axis | 2026-04-09 zengram (pre-fix) | after #11/#12/#13 (solo, verified fork) | after #15+#18 (plays, multi-session, verified fork) |
|---|---|---|---|
| dj-11740 prompt tokens (rep 0) | 80,388 | 26,436 | ~77,464 |
| dj-11740 turns (rep 0) | 31 | 30 | 21 |
| dj-11740 turns (rep 2) | 31 (isolated) | — | 15 |
| completion rate | 100% | 100% | 100% |

**Honest interpretation:** we have not yet validated Zengram's compounding
value. The rep 2 turn drop (21 → 15) sits inside dj-11740's natural n=1
variance band (2026-04-09 isolated reps: 12, 30, 31). The recall pipeline's
**semantic path is silently dead** (see below), so no play has ever actually
surfaced to the model during a bench run. Every "validation" so far has
either been stale-upstream variance or fork-variance-with-broken-recall.

### Why recall has been silently broken

1. **Zeta JOIN drops columns from aliased rows** (upstream bug,
   zeta-embedded#17). `SELECT p.data FROM part p JOIN turn t ON ...` reads
   `row.data` as undefined because the projected key is `"p.data"`, not
   bare `data`. This made `recordPlay` early-return every call before PR
   #18 worked around it with two sequential queries.
2. **Zeta `embed()` silently returns NULL** (upstream bug, zeta-embedded#18).
   `SELECT embed('hello')` returns NULL, doesn't throw. So
   `UPDATE knowledge SET embedding = embed(subject || '. ' || content)`
   leaves `embedding` NULL. `recallPlays` filters `WHERE embedding IS NOT
   NULL` → zero rows. `recallFacts` has the same dead vector branch.
   Likely root cause: NAPI binding not linked against `libzeta_embed.a`
   (local-embed feature) in the current build. Needs zeta-side
   investigation or a rebuild with the right feature flag.

Until embed() returns real vectors, plays can persist (PR #18 confirmed) but
can never be recalled. Turn reductions, if any, are variance.

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

**B1. Multi-session bench methodology.** Harness landed (zengram-bench#1). **Thesis not yet validated** — multiple "validation" runs (26/26/16, 30/30/19, 21/21/15 across 2026-04-23/24) turned out to be one of: wrong binary, JOIN-bug-broken recordPlay, or NULL-embedding-broken recall. See the "Invalidated results" note at the top of this doc. Blocked on zeta-embedded#18 (embed() returns NULL) before the recall pipeline can actually fire end-to-end.

**B2. Semantic fact recall via embeddings.** Code path exists, runtime is dead. `recallFacts` and `recallPlays` both try vector similarity first; both fall through silently because Zeta's `embed()` SQL function returns NULL (zeta-embedded#18). The keyword/importance fallback in `recallFacts` is what's been running in practice. The earlier "verified 2026-04-23" note was wrong — that spot-check misread a probe environment where embeddings happened to be populated from a prior session, not evidence of recall correctness. Blocked on zeta-embedded#18 to rebuild the NAPI binding with `local-embed` wired correctly.

**B3. "Files to start with" injection.** Code shipped (#15 + #18). Runtime blocked on zeta-embedded#18 — plays persist but the embedding column stays NULL so the semantic recall that surfaces them never fires. Once embed() works, re-run the 3-rep multi-session bench and look for a genuine turn-count drop on rep 2 outside dj-11740's 12–31 variance band.

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
