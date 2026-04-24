# Zengram Elevation Plan

Living doc. Captures the levers we've considered for making `opencode + Zengram`
hit the mission goal from `CLAUDE.md`: **fewer turns, fewer tokens, match or
beat the SQLite baseline on quality.** Update this doc every time we ship an
elevation or rule something out.

---

## Status snapshot (post-2026-04-24)

**Correction 2026-04-24 evening:** the first set of numbers recorded here for
the plays feature (26 → 16 turns) came from a misconfigured bench adapter
that was running the stale upstream opencode (`~/.opencode/bin/opencode`,
March build), not our fork. `run-zengram.sh` defaulted
`OPENCODE_ZENGRAM_BIN` to the literal string `opencode`, which the harness
resolved via PATH to the wrong binary. Fixed upstream in zengram-bench#2 (now
defaults to the sibling `opencode-fork.sh`). Honest re-run below.

| axis | 2026-04-09 zengram (pre-fix, also stale upstream) | after #11/#12/#13 (solo, verified fork) | **after #15 (plays, multi-session, verified fork)** |
|---|---|---|---|
| dj-11740 prompt tokens (rep 0) | 80,388 | 26,436 | 112,261 |
| dj-11740 prompt tokens (rep 2) | — | — | **63,258** (-44% vs rep 1) |
| dj-11740 turns (rep 0) | 31 | 30 | 30 (cap) |
| dj-11740 turns (rep 2) | — | — | **19** (-37% vs rep 1 cap) |
| completion rate | 100% | 100% | 100% |

**Result after honest re-run:** the fork injects heavier system prompts than
stale upstream (plays + knowledge + workspace blocks), so rep 0 cost is
higher (112K prompt tokens) and it often hits the 30-turn cap on fresh
state. But accumulated plays do deliver: by rep 2 with two prior plays
converging on `autodetector.py`, the model completes in 19 turns and 63K
prompt tokens. That's a real 37% turn-count compounding win and a 64%
prompt-token reduction — smaller than the invalid 26 → 16 number suggested,
still genuinely validating the thesis.

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

**B1. Multi-session bench methodology.** ✅ **Validated with plays (2026-04-24, honest re-run).** Harness landed in zengram-bench#1. The initial "26 → 26 → 16" result from the bench was invalid (stale upstream binary via PATH; see zengram-bench#2 for the adapter default fix). Honest re-run against the fork: **30 → 30 → 19 turns** across 3 reps of dj-11740 multi-session — rep 0 and 1 hit the 30-turn cap because fresh/sparse plays don't yet shortcut, rep 2 drops to 19 once two converging plays point at the same file. Thesis still validated, magnitude smaller than the invalid numbers suggested: 37% turn reduction + 64% prompt-token reduction between rep 1 and rep 2.

**B2. Semantic fact recall via embeddings.** ✅ **Already active** — verified 2026-04-23. `recallFacts` takes `context` (set to the last user-message text in `prompt.ts:1512`) and runs the embedding-ranked query first (`knowledge/index.ts:125-139`). Spot-checked the dj-11740 probe state: 14 knowledge rows all stored with non-null embeddings, no embed-related errors in the log, and recalled facts were semantically relevant (Django-migration topics for a Django-migration task). Keep this lever here in case we later want to tune the 0.7/0.3 cosine-vs-importance blend.

**B3. "Files to start with" injection.** ✅ **Shipped as part of #15 (plays).** Plays record problem+files-touched and recall by embedding similarity. Measured on dj-11740 (honest re-run, post-zengram-bench#2 fix): rep 2 with 2 prior plays → **19 turns / 63K prompt tokens** (vs rep 1's 30-cap / 175K). Turn reduction: 37%. Followup: tune the recall threshold and reduce the cold-start cost on rep 0 where the block gets re-sent but doesn't yet help.

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
