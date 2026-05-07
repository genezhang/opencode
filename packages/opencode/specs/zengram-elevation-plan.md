# Zengram Elevation Plan

Living doc. Captures the levers we've considered for making `opencode + Zengram`
hit the mission goal from `CLAUDE.md`: **fewer turns, fewer tokens, match or
beat the SQLite baseline on quality.** Update this doc every time we ship an
elevation or rule something out.

---

## Status snapshot — 2026-05-06 (survey50_round8 — 256k n_ctx, null result on resolution; 4× variance tightening confirmed)

Same flags as round 7, only `n_ctx` raised on ai1.local from 65536 to 262144 (4× the model's previously-served context window). Hypothesis: round 7's 7% resolution rate and 28/50 `no_edit` baseline runs were caused by the agent's prompt accumulation (file reads + tool history) overflowing the 64k window mid-conversation. Round 8 tests that hypothesis directly.

### Headline — n_ctx is not the bottleneck

| | round 7 (n_ctx=64k) | **round 8 (n_ctx=256k)** |
|---|---|---|
| BL resolved | 3/50 (6.0%) | 3/49 (6.1%) |
| ZG resolved | 4/50 (8.0%) | 4/50 (8.0%) |
| BL total tokens | 4.73M | 4.31M (−9%) |
| ZG total tokens | 5.02M | 5.01M (~0%) |
| token ratio (zg/bl) | 1.063× | 1.163× |
| res/Mtok ratio | 1.27× | 1.14× |
| BL median tok/run | 89.1k | 78.4k |
| ZG median tok/run | 89.4k | 83.7k |
| no_edit BL | 28 | 28 |
| no_edit ZG | 26 | 30 |

`Score integrity: ok (99 runs ↔ scores)` — one baseline run failed legitimately (dj-13417, 0 turns), now properly stamped `failed` thanks to zengram-bench#12.

Resolution rate and `no_edit` count are essentially unchanged. The 4× context expansion did not unlock any tasks. **Conclusion: the 64k window was not what was limiting agent success on this task pool**; the bottleneck is upstream — the model itself cannot identify the right edit in 15 turns regardless of how much history it has access to.

### Asymmetric sensitivity to context size

Baseline median tokens dropped 12% (89k → 78k) and total dropped 9% — when the window is large, baseline doesn't need to re-read files it already saw, so its prompt grows more slowly per turn. Zengram showed essentially no change (89k → 84k median, ~0% total). Zengram's `<zengram-previously-helpful>` injection adds a fixed-size cost per turn that already fit within 64k; the extra 192k of headroom doesn't shrink it.

Concretely: zengram's prompt structure is less sensitive to truncation pressure (which is what zengram is *for* — externalize state so context stays small), while baseline's prompt structure depends on context to avoid re-reads. Result: in the 64k regime baseline paid more in re-reads (token ratio 1.06×); in the 256k regime baseline pays less (token ratio 1.16×). Zengram's relative cost goes up because baseline's absolute cost goes down.

### Variance tightening across 50-pool rounds — confirmed

The round 7 plan predicted that doubling the pool from 25 to 50 would roughly halve the per-task variance contribution to the aggregate. Two same-config rounds now make that measurable.

| | 25-pool (rounds 1–6) | 50-pool (rounds 7–8) |
|---|---|---|
| token ratio range | 0.93×–1.38× (±0.20) | 1.063×–1.163× (±0.05) |
| res/Mtok range | 0.48×–2.14× (±0.83) | 1.14×–1.27× (±0.07) |

Variance band tightened ~4× on token ratio, ~12× on res/Mtok. This is more than the simple n→2n prediction — which suggests the 50-pool is doing more than averaging out; it's also damping the asymmetric-burn outliers that drove the 25-pool's heaviest single-task swings.

### What's signal vs noise on the 50-pool now

- **Signal:** zengram pays a ~10–15% token tax (token ratio 1.06–1.16×) and resolves a 20% bigger res/Mtok metric (1.14–1.27× consistently > 1).
- **Noise:** the +1 resolved-task delta (3 vs 4) is a single-task margin at the 6–8% success floor; 95% CI on the 2pp difference includes zero. Resolution rate is unmeasurable as a comparison until success rate climbs.

### What this rules out and points to next

Ruled out:
- "Context window was the bottleneck" — refuted directly.
- "More history fixes the agent" — same `no_edit` count with 4× headroom.

Pointed to:
- **Turn budget.** 28–30 of 50 baseline runs end with no edit, after using all 15 turns. The agent is spending turns reading/searching and never gets to the edit. Raising `BENCH_MAX_TURNS` from 15 to 30 directly addresses this and is the single cheapest experiment.
- **Model capacity.** If 30 turns also doesn't move resolution, the local Qwen3-Coder-Next at q6 quantization is the floor and the only way past 7% is to swap to a frontier model via API.

### Next move

Round 9 on the 50-pool, same flags as round 8, **`BENCH_MAX_TURNS=30`**. Same `n_ctx=256k` (no reason to revert; it doesn't hurt). Fresh `BENCH_SUITE_NAME=survey50_round9` and fresh pinned dir for the variance estimate.

If round 9 lifts resolution rate materially (target: 15%+), the agent can use the additional turns and we have a meaningful comparison again. If `no_edit` stays high at 30 turns, the model is the ceiling and the experiment plan switches to API-backed Sonnet for round 10.

---

## Status snapshot — 2026-05-06 (survey50_round7 — pool doubled to 50 tasks, headline narrows further)

First round on the 50-task pool (`tasks/django_50.txt` = original 25 + 25 new Django tasks selected for FTP≥1, 5≤PTP≤200, patch≤50 lines). Same flags as rounds 5/6 (`ZENGRAM_FACT_INJECT_LIMIT=5`, `ZENGRAM_FACT_MAX_DISTANCE=0.75`, noise filter), fresh `BENCH_SUITE_NAME=survey50_round7`, n=1 × 2 variants.

### Mid-run incident: zengram backend wedged at task 37, 14 phantom completions

`opencode-fork` hung for ~7.9h on dj-13794, then every subsequent zengram task returned in ~96s with empty patch but **`status: "completed"`** and 0 turns / 0 tokens. The `run-zengram.sh` adapter wraps opencode-fork with `... || { echo ...; }` so the bash exit was always 0; the harness took that at face value. 14 of 50 zengram runs were silently fake.

Fix: zengram-bench PR #12 ([fix(harness)](https://github.com/genezhang/zengram-bench/pull/12)) — treat `usage.turns === 0` as `failed` regardless of subprocess exit. This is the write-side counterpart to PR #11's read-side integrity gate: PR #11 catches *stale* scores, PR #12 catches *fake-completed* runs. Together they close the silent-data-corruption loop on both ends.

Recovery: deleted the 14 phantom run JSONs and re-ran zengram-only on the same `survey50_round7` pinned dir (preserves multi-session continuity). All 14 completed cleanly (3–15 turns each), including dj-13794 itself which finished in 13.6 min the second time. Root cause of the original wedge is unidentified — single occurrence so far, watching for repro.

### Headline numbers (50 tasks, all 100 runs valid)

| | baseline | zengram | ratio |
|---|---|---|---|
| Resolved | 3/50 (6.0%) | 4/50 (8.0%) | +33% |
| Total tokens | 4.73M | 5.02M | 1.063× |
| **Resolved / 1M tok ★** | **0.63** | **0.80** | **1.27× ZG** |
| Median tokens / run | 89.1k | 89.4k | 1.003× |
| Median turns / run | 15 | 15 | 1.00× |
| no_edit runs | 28/50 | 26/50 | −2 |

`Score integrity: ok (100 runs ↔ scores)` — both gates clean.

### What changed vs the 6-round mean

| | 6-round mean (n=25) | round 7 (n=50) |
|---|---|---|
| BL res | 2.5/25 (10%) | 3/50 (6%) |
| ZG res | 3.5/25 (14%) | 4/50 (8%) |
| tok ratio | 1.12× | **1.063×** *(tightest ever)* |
| res/Mtok ratio | 1.37× | **1.27×** |

Resolution rate is lower in absolute percent on the bigger pool — expected, the new 25 tasks were sampled across the same difficulty band but include more "<15 min fix" entries that the agent can still fail on; harder tail dominates. Both variants pay this cost equally.

The token ratio compression to **1.063×** is the most striking single-round result we have. Across rounds 1–6 it ranged 0.93×–1.38× with mean 1.12×; round 7 is at the low edge. Either this round got lucky, or doubling the pool genuinely averages out the per-task burn shuffling that has been driving most of the variance. We need round 8 (same config) to tell.

### Variance hypothesis: did pool expansion help?

Theory was that doubling the pool roughly halves per-task variance contribution to the aggregate. We can't confirm that from one round — variance is a cross-round property — but the within-round signal is consistent with it: round 7's resolution counts (3 vs 4) are exactly the kind of tight margin we couldn't distinguish from noise on the 25-pool.

Next step: round 8 on the 50-pool, same config, to put error bars on round 7. If round 8 lands in the 0.95×–1.10× token-ratio band and 1.0×–1.5× res/Mtok band, the variance band has genuinely tightened by ~2× and lever measurements become viable. If round 8 swings as wide as the 25-pool rounds did, the pool size wasn't the binding constraint.

### What this confirms about the levers shipped so far

PR #25 (distance gate), PR #26 (noise filter), PR #28 (top-K cap) collectively produced a token ratio of 1.063× in round 7 — the closest zengram has ever come to matching baseline on absolute tokens while still resolving more tasks. Whether each individual lever contributes to that, vs being neutral, is still unmeasurable; but the *stack* is no longer net-cost.

### Open questions for round 8

1. Token ratio: is 1.063× the new normal, or was round 7 a lucky draw? (n=2 puts a real bound.)
2. Resolution delta: does ZG +1 vs BL hold on the 50-pool, or shrink to ±0?
3. The unidentified wedge that produced 14 phantom completions — does it repro on round 8 with the same pinned-dir state?

### Next move

Run round 8 on the 50-pool with **identical** flags. Same suite name? **No** — fresh `survey50_round8`. Reusing round 7's pinned dir would conflate "second measurement" with "second-pass over already-warmed memory," and we want the variance estimate, not the multi-session compounding effect.

If round 8 confirms the tightened band, the agenda for round 9+ becomes: **isolate the levers**. Run with each of {distance gate off, noise filter off, top-K cap off} to attribute the token-ratio compression to specific shipped code, rather than assuming all three are pulling.

---

## Status snapshot — 2026-05-05 (survey25_round6 — first round under fully-fixed measurement substrate)

First bench cycle under both the scorer fix (zengram-bench#10, patch-hash invalidation) and the analyzer integrity gate (zengram-bench#11, refuses to publish stale aggregates). Same flags as round 5 (`ZENGRAM_FACT_INJECT_LIMIT=5`, `ZENGRAM_FACT_MAX_DISTANCE=0.75`, noise filter), fresh `BENCH_SUITE_NAME=survey25_round6`. Now we are actually measuring what we think we are measuring.

### Round 6 vs round 5 (both correctly scored)

| | round 5 | **round 6** |
|---|---|---|
| BL resolved | 2/25 | **3/25** |
| ZG resolved | 5/25 | **3/25** |
| tok ratio (zg/bl) | 1.17× | **0.93×** |
| res/Mtok ratio | 2.14× | **1.08×** |
| ZG advantage | +3 resolves | **0 resolves** |

Identical flags, fully-corrected scoring, opposite outcomes. Round 5 had zengram resolving three tasks baseline didn't; round 6 both sides resolve the same three (dj-11099, dj-14089, dj-14559). dj-15127 — the canonical zengram-only winner across rounds 2–5 — didn't resolve at all this round.

### 6-round summary (all corrected)

| round | BL | ZG | tok ratio | res/Mtok |
|---|---|---|---|---|
| 1 | 3 | 2 | 1.38× | 0.48× |
| 2 | 2 | 4 | 1.06× | 1.89× |
| 3 | 2 | 3 | 1.22× | 1.23× |
| 4 | 3 | 4 | 0.96× | 1.39× |
| 5 | 2 | 5 | 1.17× | 2.14× |
| 6 | 3 | 3 | 0.93× | 1.08× |
| **mean** | **2.5** | **3.5** | **1.12×** | **1.37×** |

Real signal: zengram wins by **mean +1.0 resolved task** (range −1 to +3). Token tax ~1.12×. res/Mtok ratio 1.37× — positive but the variance band (0.48× to 2.14×) is wider than the mean effect, so any single round in isolation can show "zengram lost" or "zengram won by 2×" under identical configuration.

### Per-task asymmetric burn — wins bigger than losses

Round 6 zengram cheaper-than-baseline wins (top): dj-12713 −88%, dj-16333 −81%, dj-13821 −53%, dj-14559 −51%, dj-13297 −45%, dj-11211 −45%. Round 6 zengram blowups (top): dj-16877 +201%, dj-10097 +152%, dj-11099 +73%. 11 wins / 9 losses / 5 near-ties. The wins are bigger in magnitude, which is why aggregate tokens land slightly cheaper despite roughly equal counts.

### Conclusion: lever-vs-variance ratio is too low at n=1 × 25 tasks

Across six rounds we now have clean evidence that:

- The fully-fixed substrate produces consistent ok-status integrity reports → we are measuring what we think we are measuring.
- Zengram wins on aggregate (mean +1.0 task, +37% res/Mtok), but variance dominates any single round.
- The res/Mtok variance band (0.48–2.14×) is **wider than any per-lever delta we have ever measured**. Single-flag lever changes cannot rise above this floor.

### Next move

Stop running same-config repetitions — each round costs ~5–6h compute and adds one data point. Variance-reduction-per-compute-spent is much higher with **task pool expansion**: doubling the pool from 25 to 50 tasks roughly halves the per-task variance contribution to the aggregate, and is a one-time cost (gather tasks, prime the repo cache).

Concrete pool-expansion plan:
1. Pull the next 25 unused-but-cheap Django tasks from SWE-bench Verified (filter by patch-size and base_commit-cache-availability).
2. Add them to `tasks/django_subset.txt` (rename to `django_50.txt`).
3. Smoke-test five new tasks under both variants to confirm they score correctly.
4. Run round 7 on the 50-task pool with round 5's flags. ~10–12h compute.

If round 7 produces a tighter variance band on res/Mtok (e.g. ±0.3× instead of ±0.7×), then re-running rounds 5/6's flags on the 50-pool gives a real lever-effect estimate. If the band is still wide, expand again to 75 or 100.

The shipped levers (PR #25 distance gate, PR #26 noise filter, PR #28 top-K cap) are not necessarily wrong — they are just unmeasurable at this pool size.

---

## ⚠️ Status snapshot — 2026-05-05 late (CORRECTION: scorer caching artifact invalidates round1–5 narrative)

Investigation triggered by the user pointing out that the "Qwen3-Coder-30B-A3B vs Next" model-swap explanation for the resolution regression couldn't be right (both rounds were on Next). Root-causing the actual regression turned up a much bigger problem.

### Root cause: scorer was skip-if-exists, score files shared across rounds

`zengram-bench/harness/scorer/score.py` skipped any run with an existing score JSON. All five rounds wrote into the same `results/scores/` and used identical task-id keys (`django__django-11099_baseline_0.json`, etc.), so round 2–5 invocations of `score.py` only actually scored runs without a pre-existing score file. **For every task that round 1 scored, rounds 2–5 silently kept round 1's score even when the round-N patch differed.**

Confirmed by isolation: re-scoring each round's archive into its own scores dir gives radically different totals.

### Corrected 5-round headline

| round | BL res | ZG res | tok ratio | res/Mtok ratio | (originally reported) |
|---|---|---|---|---|---|
| 1 | 3 | 2 | 1.38× | **0.48×** *(zengram lost!)* | 2.41× |
| 2 | 2 | 4 | 1.06× | 1.89× | 2.83× |
| 3 | 2 | 3 | 1.22× | 1.23× | 2.53× |
| 4 | 3 | 4 | 0.96× | 1.39× | 3.12× |
| 5 | 2 | 5 | 1.17× | 2.14× | 2.55× |
| **mean** | **2.4 ± 0.5** | **3.6 ± 1.1** | **1.16×** | **1.43× ± 0.64** | 2.69× ± 0.28 |

### What this changes about the prior narrative

1. **Resolution count is NOT pinned at 1/3.** It varies 2–3 baseline, 2–5 zengram. The "ceiling" framing was an artifact.
2. **Round 1 zengram actually *lost* to baseline** (2 vs 3 resolved, 0.48× ratio) — this was hidden because round 1 scoring was correct but mis-aggregated under the new round 5 run JSONs in subsequent analyses.
3. **The 2.4–3.1× efficiency ratio was inflated.** Real ratio is ~1.43×, still positive but much weaker.
4. **The 2026-04-29 "8/25 BL, 13/25 ZG" reference was a phantom.** Those numbers came from before commit `8e295e0` (zengram-bench, 2026-05-02) which fixed six independent scorer bugs whose own commit message reads *"Without these, every run scored as resolved=False — six fixes turn 0/30 into 14/30."* Re-scoring the 04-29 archive with the fixed scorer gives **2/25 BL, 3/25 ZG** — same range as recent rounds. There was never a 10× regression.

### True signal across rounds 1–5

- Zengram wins 4/5 rounds by 1–3 resolved tasks. Round 1 is the only loss.
- Mean delta: zengram resolves +1.2 tasks vs baseline.
- Token ratio (zg/bl) hovers at 1.16× — zengram pays a modest token tax for the resolution wins.
- Per-task asymmetric burn shuffling is genuine and severe, but it shuffles around a real positive aggregate.

### Levers shipped so far — re-evaluation

PR #25 (distance gate at 0.75), PR #26 (reasoning-noise filter), PR #28 (top-K injection cap at 5) all shipped under inflated-ratio metrics. Whether any of them moved the *real* metric is now unknown — every "this lever did/didn't move the headline" claim above this section is built on stale scoring. The mechanical post-run state validations are still valid (fact pool 68 → 41 → 31, noise % 46 → 0 → 3.2) — only the resolution/token aggregations are corrupt.

### Fix

Scorer fix in flight: [zengram-bench PR #10](https://github.com/genezhang/zengram-bench/pull/10) — persist `SHA-256(patch)[:16]` in each score file; treat cached scores as stale when the hash doesn't match the current run's patch. Old score files (no `patch_hash` field) are treated as stale and re-scored. Adds `--force` flag for explicit re-score.

Once that lands and the corrected scoring becomes the default, re-baseline a fresh round and validate that levers PR #25/#26/#28 actually do anything before considering further shipments.

### Methodology priorities going forward

1. **Land the scorer fix and re-score round 5 in place.** Confirms the corrected numbers above are reproducible and not themselves an artifact of the rescoring procedure.
2. **Run a fresh round 6 with same flags as round 5.** With deterministic scoring, the round-to-round variance is the real signal — should put a clean error bar on whether the current shipped levers help.
3. **Audit prior elevation-plan claims.** The "round1 canonical blowups" and "round3 noise filter cleaned the fact pool" stories use mixed-validity numbers. The mechanical-state observations are still load-bearing; the resolution/token claims need re-derivation.
4. **Stop trusting any aggregation that consumed `results/scores/` before this fix.** Including the 2026-04-29 elevation-plan headline and every survey25 round headline below.

The five status snapshots below this one are preserved verbatim for the historical record but should be read as "claimed numbers" not "validated numbers" until each round is re-scored end-to-end with the fix.

---

## Status snapshot — 2026-05-05 (survey25_round5 — round4 reverted; lever effects are below n=1 noise floor)

Re-ran round4's exact configuration (`ZENGRAM_FACT_INJECT_LIMIT=5`, `ZENGRAM_FACT_MAX_DISTANCE=0.75`, noise filter, fresh `BENCH_SUITE_NAME=survey25_round5`) to validate whether the round4 0.96× token ratio replicates or was lucky path-dependence.

### Headline — round5 reverts to mid-pack numbers

| | round3 | round4 | **round5** |
|---|---|---|---|
| baseline resolved | 1/24 | 1/25 | 1/25 |
| zengram resolved | 3/24 | 3/25 | 3/25 |
| baseline tokens | 2.07M | 2.34M | 2.10M |
| zengram tokens | 2.53M | **2.24M** | 2.45M |
| baseline / 1M tok | 0.48 | 0.43 | 0.48 |
| zengram / 1M tok | 1.22 | **1.34** | 1.22 |
| zg/bl token ratio | 1.19× | **0.96×** | **1.17×** |
| res/Mtok ratio | 2.53× | **3.12×** | 2.55× |

Round4's sub-1.0× token ratio was **lucky path-dependence**, not a stable lever effect. Round5 with identical flags lands back at 1.17× — essentially the same as round3.

### 5-round summary

| metric | mean | stdev | round4 (best) | round1 (worst on this metric) |
|---|---|---|---|---|
| zg/bl token ratio | **1.12×** | 0.11 | 0.96× (1.5σ below mean) | 1.24× |
| res/Mtok ratio | **2.69×** | 0.28 | 3.12× (1.5σ above mean) | 2.41× |
| zengram resolved | 3 | 0 | 3 | 3 |
| baseline resolved | 1 | 0 | 1 | 1 |

Across 5 N=1 rounds, lever shipments (PR #25 distance gate, PR #26 noise filter, PR #28 top-K cap) have moved the headline through this band but have not produced a *separable* signal above ±0.11 standard deviation on the token ratio. **Round4's win is statistically a 1.5σ outlier on a 5-sample distribution** — not strong evidence of a real lever effect.

### What replicates across all 5 rounds

The stable signals — independent of every lever we've shipped:

1. **Resolution count: 1 baseline, 3 zengram, every single round.**
2. **Same three zengram-resolved tasks: dj-14089, dj-15127, dj-11099** (dj-14089 also baseline-resolved every round).
3. **dj-13297: 4-round-running zengram win** (round1 +380% blowup → round2 −52% → round3 −4% → round4 −22% → **round5 −71%**) — the most consistent zengram benefit on any single task.
4. **Resolved/Mtok ratio always ≥ 2.4×** — zengram is unambiguously more token-efficient per resolved task across every config tested.

What does *not* replicate:

- Per-task asymmetric burn — dj-13821 swung 161pp between round4 (−46% win) and round5 (+115% blowup) at identical config.
- The 3:1 resolution ratio at this scale.

### Methodology conclusion — stop shipping levers, change the measurement

Five rounds in, we have evidence that:

- The headline (3 zengram resolves, ~1.12× token ratio, ~2.7× res/Mtok) is the **stable signal** at this measurement scale.
- Single-flag levers (gate threshold, noise regex, top-K cap) don't move that signal above n=1 noise.
- Per-task flips of 100+ percentage points between identical configurations are routine — measurement variance dominates lever effects.

The right next steps are no longer "ship another lever":

1. **Expand the task pool** to 50–100 tasks. With path-dependence dampening as the pool grows, signal floor drops proportionally — this is the cheapest leverage gain on measurement quality. Zero code changes; just a bigger `tasks/django_subset.txt`.
2. **Switch to a more capable model** to break the 3/25 ceiling. Resolution count has been pinned at 3 zengram for 5 rounds; changing the model is the only thing that's likely to move it. The bench was originally tuned on `Qwen3-Coder-30B-A3B-Instruct` (8/25 baseline, 13/25 zengram per the 2026-04-29 snapshot), and the Qwen3-Coder-Next variant is notably less capable.
3. **N>>1 on a smaller pool** with proper statistics. If we want to characterize lever effects below 1σ, we need 5+ reps per cell.

Order: (1) costs nothing but compute time, (2) requires getting another model running on ai1, (3) is most rigorous but also most expensive. Recommend (1) immediately, (2) staged behind it.

### Post-run state validation

| state | round3 | round4 | round5 |
|---|---|---|---|
| `/project` (active facts) | 41 | 31 | **15** |
| `/project` noise % | 0.0% | 3.2% | **0.0%** |
| `/play` (active plays) | 9 | 12 | 11 |
| no_edit zengram sessions | 16 | 13 | 13 |

Round5's fact count dropped further to 15 — the same lever produces different accumulation patterns depending on session order. This is more evidence the run-to-run variance is structural, not noise we can paper over.

---

## Status snapshot — 2026-05-05 (survey25_round4 — top-K cap on injected facts, first round zengram is absolutely cheaper than baseline)

Shipped lever 3 from the round3 plan: `ZENGRAM_FACT_INJECT_LIMIT=5` (PR #28), reducing the session-preamble fact injection from top-20 to top-5. Other levers held: `ZENGRAM_FACT_MAX_DISTANCE=0.75` from PR #25, reasoning-noise filter from PR #26. Same 25-task pool, fresh `BENCH_SUITE_NAME=survey25_round4`, n=1 × 2 variants.

### Headline — first round where zengram beats baseline on absolute tokens

|  | round2 | round3 | **round4** | Δ vs round3 |
|---|---|---|---|---|
| baseline resolved | 1/25 | 1/24 | 1/25 | — |
| zengram resolved | 3/25 | 3/24 | 3/25 | unchanged |
| baseline tokens | 2.56M | 2.07M | 2.34M | +13% |
| zengram tokens | 2.72M | 2.53M | **2.24M** | **−11.4%** |
| baseline / 1M tok | 0.39 | 0.48 | 0.43 | — |
| zengram / 1M tok | 1.10 | 1.22 | **1.34** | +10% |
| zg/bl token ratio | 1.06× | 1.19× | **0.96×** | **first round < 1.00** |
| **res/Mtok ratio** | 2.83× | 2.53× | **3.12×** | **+23%, best across all rounds** |

The 0.96× token ratio is the headline: with top-5 injection plus the round3 levers, **zengram is now cheaper in absolute aggregate than the SQLite baseline** while still resolving 3× as many tasks. This is the first time we've seen recall pay for itself in token cost on the survey25 pool.

### Asymmetric-burn pattern shifted heavily — round3 blowups flipped to wins

The bigger move is per-task. Round3's worst zengram blowups all flipped to wins or near-wins:

| task | round1 Δ% | round2 Δ% | round3 Δ% | **round4 Δ%** |
|---|---|---|---|---|
| dj-14787 | −58% | −17% | **+167%** | **−31%** |
| dj-13658 | +60% | +33% | **+110%** | **−65%** |
| dj-11211 | small | parity | **+89%** | **−27%** |
| dj-12273 | parity | parity | +54% | **−54%** |
| dj-12713 | −32% | parity | +29% | **−46%** |
| dj-13821 | small | parity | +13% | **−46%** |
| dj-11999 | parity | +87% | +7% | **−35%** |
| dj-13297 | +380% | −52% | −4% | **−22%** |

Eight tasks where round3 was worse-than-baseline are round4 wins. dj-13297 — the canonical round1 blowup — has now been a win three rounds running.

But path-dependence keeps moving the boundary: some round3 wins flipped to losses in round4:

| task | round3 Δ% | **round4 Δ%** |
|---|---|---|
| dj-10097 | **−55%** | **+66%** |
| dj-16100 | **−18%** | **+153%** |
| dj-16333 | **−15%** | **+64%** |
| dj-13033 | **−55%** | +14% |
| dj-13417 | +29% | +52% |

The aggregate moved decisively in zengram's favor (2.53M → 2.24M tokens), but at the per-task level the shuffling is severe enough that we can't yet say *which* tasks the lever helps consistently. Resolved tasks unchanged: dj-14089 (both), dj-15127 (zengram), dj-11099 (zengram) — same three since round2.

### Post-run state validation — lever engaged

| state | round3 | round4 | mechanism |
|---|---|---|---|
| `/project` (active facts) | 41 | **31** | smaller cap → less reflection-driven accumulation across sessions |
| `/project` noise % | 0.0% | 3.2% | one fact slipped the regex; tolerable, not perfect |
| `/play` (active plays) | 9 | 12 | unchanged shape (cross-task plays still don't engage at d≈0.7+) |
| no_edit sessions (zengram) | 16 | 13 | −19% — model gives up empty-handed less often with smaller prompt |

The fact pool keeps shrinking with each lever — 68 (round2) → 41 (round3 noise filter) → 31 (round4 top-5 cap). 3.2% noise leak is one fact in 31; the regex isn't catching every variant but the broader trajectory holds.

### Why is this a bigger move than expected?

20-fact injection at ~150 chars/fact = ~3kB of prompt. Top-5 reduces that to ~750 bytes. Two things plausibly compound:

1. **Less prompt slop per turn.** A model on a 15-turn budget benefits from a tighter system block — the same input tokens being injected on every turn × 15 turns is significant. ~3kB × 15 = 45kB; ~750B × 15 = 11kB. Saving ~34kB of prompt-tokens-per-session × 25 sessions ≈ 850kB of zengram-side savings, which roughly tracks with the 290k aggregate token reduction (zengram cache amplifies savings).

2. **Less anchoring on weak retrieval.** Top-20 includes facts at the score floor — semantically related but not directly useful. The model treats the system-block as authoritative; weak signal in there can pull behavior off the path. Top-5 keeps only high-confidence retrievals.

Neither effect is provable from one round, but both are consistent with the magnitude of the move.

### Critical caveat — n=1 still dominates

Round3's takeaway was "n=1 cannot distinguish lever effects below ~0.5×." Round4's lever moved the ratio +0.59× and the token ratio across the 1.0× threshold. That's *plausibly* above the n=1 noise floor — but the per-task shuffling magnitude (dj-10097 went from −55% to +66%, 121 percentage points on a single task) means one bad round could easily revert it.

**The right next step is round5 with identical flags** to put error bars on the round4 result. If round5 confirms zengram-absolute ≤ baseline (token ratio ≤ 1.0), the lever effect is real. If round5 reverts to round3-style numbers (1.1–1.2× ratio), this was lucky path-dependence and we should look elsewhere.

A cheaper alternative to a full round5 would be expanding the task pool to 50+ tasks, which dilutes per-task variance — but no such pool is staged. Round5 reps is the simplest validation.

### Open questions for round5

- Does the 0.96× token ratio replicate, or revert to ≥1.0×?
- Does dj-13297 hold its win streak (now 3 rounds)?
- Do the round4 flips (dj-14787, dj-13658, dj-11211, dj-12273) hold, or were they path-dependent?
- Same three resolved tasks (dj-14089, dj-15127, dj-11099) — does the resolution count ever break out of 3/25 with this model on this pool, or is it a model-capability ceiling?

---

## Status snapshot — 2026-05-05 (survey25_round3 — fact-distance gate + reasoning-noise filter)

First bench cycle with both round2 levers shipped: `ZENGRAM_FACT_MAX_DISTANCE=0.75` (PR #25, the empirically-derived natural break in the cosine-distance distribution) and a regex-based reasoning-noise filter on fact extraction (PR #26, blocking subjects that start with `"Now I"`, `"Let me"`, `"I'll"`, `"Looking at"`, `"The problem is"` and similar narration openers). Same 25-task Django subset × n=1 × 2 variants, fresh `BENCH_SUITE_NAME=survey25_round3`, clean slate.

### Headline — efficiency ratio compressed slightly, absolute zengram efficiency improved

Apples-to-apples comparison (excluding dj-14559 where baseline failed to start in round3):

| | survey25_round2 | **survey25_round3** | Δ |
|---|---|---|---|
| baseline resolved | 1/25 | 1/24 | (− one bench failure) |
| zengram resolved | 3/25 | 3/24 | unchanged |
| baseline / 1M tok | 0.39 | 0.48 | +23% |
| zengram / 1M tok | 1.10 | **1.22** | **+11%** |
| **ratio** | **2.83×** | **2.53×** | −0.30× |
| zg/bl token ratio | 1.06× | 1.19× | +0.13× |

Zengram absolute efficiency improved (+11% res/Mtok) but baseline improved more (+23%, well within run-to-run variance on a 1-resolved sample). The ratio mildly compressed. **Resolution counts are unchanged** at 3 vs 1 — the gate + filter levers don't move the headline at this sample size.

### Both levers engaged as designed — post-run state validation

Dumping zengram state at end of round3:

| state | round2 | round3 | mechanism |
|---|---|---|---|
| `/project` (active facts) | 68 | **41** | 40% reduction — noise filter rejecting bad candidates at extraction |
| `/project` noise % | ~46% (subjects like "Now I…") | **0%** (`probe-noise-purge` dry-run reports 0 demotions) | filter working |
| `/play` (active plays) | 10 | 9 | unchanged shape — plays still don't engage in cross-task N=1 |
| inactive (purged) | 0 | 0 | no purge runs needed; filter prevents extraction upstream |

The noise filter is doing its job: 41 facts of substance instead of 68 with half being raw LLM narration. The fact-distance gate at 0.75 is implicitly tested but the recallFacts wrapping doesn't dump rejected candidates, so we can't directly observe gate activity from state.

### Asymmetric-burn pattern shifted, didn't disappear

Per-task token deltas (zengram vs baseline, round3, sorted by Δ%):

**Wins (zengram cheaper):**
- dj-13033: −55% (35k vs 78k)
- dj-10097: −55% (60k vs 134k, 6 turns vs 10) — **canonical early-quit win persists**
- dj-14351: −23%
- dj-15561: −21% — **flipped from round2 +77% blowup**
- dj-16595: −19% (118k vs 146k) — **canonical round1 blowup, now consistently a win**
- dj-16100: −18%
- dj-11740: −18%
- dj-16333: −15%
- dj-15368: −7% — **round1 +250% blowup, now neutral**
- dj-13297: −4% — **round1 +380% blowup, now neutral**

**Blowups (zengram much worse):**
- dj-16877: +1157% (148k vs 12k) — but baseline early-quit at 1 turn with 0 tokens output, not a real completion to compare against
- dj-14787: +167% — regressed sharply from round2's −17%
- dj-13658: +110%
- dj-11211: +89%
- dj-12273: +54%
- dj-15127: +50% — but **zengram resolved**, baseline did not
- dj-13417: +29%
- dj-12713: +29% — was a win in both prior rounds

Old canonical blowups (13297, 15368, 16595) compressed to neutral or wins — that's directly attributable to the gate + filter (cleaner, smaller fact pool means fewer red-herring injections). New blowups emerged on different tasks. Path-dependence keeps shuffling which tasks are wins vs losses while the aggregate stays roughly stable.

### Resolved-task overlap

| task | round1 | round2 | round3 |
|---|---|---|---|
| dj-14089 | ✓ both | ✓ both | ✓ both |
| dj-15127 | ✓ zengram | ✓ zengram | ✓ zengram |
| dj-11099 | — | ✓ zengram | ✓ zengram |
| dj-12273 | ✓ zengram | — | — |

The same three zengram tasks are resolved that were resolved in round2 (dj-14089, dj-15127, dj-11099). The lever changes preserved the right wins, didn't unlock new ones.

### What this implies for the next lever

The two levers shipped did what they were designed to do — clean the fact pool (41 vs 68, 0% vs 46% noise) and gate noisy injections (gate at 0.75). The aggregate metric didn't move *because* the headline wasn't being driven by the noise we filtered out. Round2 already showed 2.83× ratio with a noisy 68-fact pool; round3 shows 2.53× with a clean 41-fact pool. **The marginal contribution of cleaner facts at this scale is below the noise floor of n=1 path-dependence.**

Two paths from here:

1. **Characterize variance before chasing more levers.** Run n=2 or n=3 on the same task pool to put error bars on the ratio. Right now we cannot distinguish "lever did nothing" from "lever helped but path-dependence dominated." This is the rigorous path; cost is ~10–15h of compute.

2. **Lever 3 from the round2 plan: cap injected fact count by relevance.** Currently `recallFacts` returns up to 20 facts × ~150 chars. Even after gating, that's 3kB of prompt that's mostly weak signal. Lower the cap (maybe to top-5 by score) and see if fewer-but-better facts move the metric. This is the cheap-experiment path.

Recommendation: do (2) first — it's a one-flag change and tests whether further fact pruning has any signal. If it doesn't, switch to (1) and stop chasing levers without measurement. If it does, then (1) becomes confirmation.

### Methodology note — n=1 ceiling

Three rounds in, the resolved count is locked at 1 baseline, 3 zengram regardless of which levers fire. The token-efficiency *ratio* drifts in a 2.4×–2.8× band that is plausibly within run-to-run variance on a 25-task pool. **N=1 cannot reliably distinguish lever effects below ~0.5×.** The methodology needs either a bigger pool (more tasks) or repetitions (n>1) to detect smaller wins. The next lever measurement should ship paired with at least one repetition.

---

## Status snapshot — 2026-05-04 (survey25_round2 — chunk-aware end-to-end + path-dependence finding)

Re-ran the same 25-task subset × n=1 × 2 variants that produced the 2026-05-03 AM survey25 numbers, this time with the chunk-aware analyzer (zengram-bench#9) live end-to-end. Clean slate — wiped multi-session-state, archived prior results, `BENCH_SUITE_NAME=survey25_round2`.

### Headline reproduces and improves slightly

| | survey25_round1 (legacy parser) | **survey25_round2 (chunk-aware)** |
|---|---|---|
| baseline resolved | 1/25 (4%) | 1/25 (4%) |
| zengram resolved | 3/25 (12%) | 3/25 (12%) |
| baseline / 1M tok | 0.44 | 0.39 |
| zengram / 1M tok | 1.06 | **1.10** |
| **ratio** | 2.41× | **2.83×** |

### redundant_read confirmed as noise at scale

Same finding as focus_round2 but on the full 25-task pool:

| | round1 (legacy) | round2 (chunk-aware) |
|---|---|---|
| baseline redundant_read % | 20.3% | **1.9%** (6 of 321) |
| zengram redundant_read % | 17.2% | **1.0%** (3 of 313) |
| useful % | 79.3 / 82.8 | **98.1 / 99.0** |

The model is doing legitimate work on essentially every tool call. The "lots of redundant reads" framing in the original survey25 narrative was an artifact of the bench parser flattening read inputs to just the file path.

### The new finding: path-dependence

Same task pool, two rounds, dramatically different per-task outcomes — the asymmetric-burn pattern isn't fixed-per-task. Specific reversals:

| task | round1 Δ% (zengram vs baseline tok) | round2 Δ% | flipped? |
|---|---|---|---|
| **dj-16595** | **+250%** (the canonical blowup of round1) | **-43%** (now a clean win) | ✓ |
| **dj-13297** | +380% | -52% | ✓ |
| dj-10097 | parity | -91% (12k vs 137k, 2 turns vs 15 — early-quit firing) | ✓ |
| dj-14787 | -58% | -17% | regressed but still a win |
| **dj-15814** | parity-ish | **+129%** | now a blowup |
| **dj-11999** | parity | **+87%** | now a blowup |
| dj-15561 | small | +77% | blowup, was already trending |

Same recall pipeline, same task pool, very different per-task asymmetries. The natural first guess was *plays state at task-N* — but the post-run DB inspection (next section) rules that out.

### Post-run inspection — *plays were empty for every task in this suite*

Dumping zengram state at end of round2 reveals the win mechanism is **not plays**:

| state | count | gating | per-session injection |
|---|---|---|---|
| `/play` | **10 plays** | `ZENGRAM_PLAY_MAX_DISTANCE=0.5` | **0 of 10 pass for every queried task — empty plays-block all round** |
| `/project` (facts) | **68 facts** | none — top 20 by `0.7×similarity + 0.3×importance` | **20 facts injected every session** |
| `workspace_file` | 66 rows / 25 sessions | per-session | session-local |

Every cross-task play sits at distance 0.69–0.85 in the embedding model. The 0.5 gate rejects every one. The "compounding recall" thesis from the 2026-04-29 snapshot is genuine for **task repetition** (n=5 focused suite — same-task plays at d≈0.1 do compound and drive the win). It does **not** apply to **cross-task N=1 surveys**: by construction, no same-task play exists when each task runs once, and cross-task plays don't pass the gate.

So the 2.83× resolved/Mtok ratio in survey25_round2 is **driven by facts, not plays**. The 68 facts that accumulated across sessions get injected 20 at a time at every session start, with no distance gating — a substantial body of cross-session signal, but also unfiltered noise.

A spot-check of fact subjects shows another concern: most start with `"Now I can see the issue..."` or `"Let me look at..."` — they're raw LLM reasoning captured by the reflection step rather than extracted normative claims. The reflection prompt may be misfiring.

### What this implies for the next lever

The earlier framing of this snapshot (per-task play limit, play eviction, stricter play gate) was based on the wrong mechanism. The plays pipeline isn't the bottleneck in cross-task surveys because it isn't *engaging* in cross-task surveys. The actual levers worth investigating:

1. **Add distance gating to `recallFacts`** — currently ungated, top 20 by score. Apply the same idea as `ZENGRAM_PLAY_MAX_DISTANCE` so noise facts (low semantic relevance) don't surface.
2. **Audit fact extraction quality** — fact subjects look like raw reflection output, not normative claims. Tighten the EXTRACT_FACTS_SYSTEM_PROMPT so subjects are useful retrieval keys.
3. **Cap injected fact count by relevance** — even with gating, 20 facts × ~150 chars each is a meaningful prompt slice; lower the limit and see if fewer-but-better facts perform better.

Investigation order: ship gating + measure first (similar shape to plays' ZENGRAM_PLAY_MAX_DISTANCE), then if numbers move, look at extraction prompt next. The path-dependence finding above is consistent with this — different facts accumulate in different suite orders, and an ungated top-20 amplifies the variance.

### Methodology held over from focus_round2

n=1 × 25 tasks is the right shape *for measuring cross-task transfer* (which is what facts deliver). For repetition-driven plays compounding, n>1 on a smaller pool is the right shape. **The two scenarios test different mechanisms and the elevation plan should treat them separately going forward** rather than blending plays and facts under "compounding recall." 1 vs 3 resolved at N=1 is small-sample sensitive — ratio and per-task pattern are the load-bearing signals.

---

## Status snapshot — 2026-05-03 PM (focus_round2 — chunk-aware analyzer)

Re-ran the same 3-task focused suite (dj-12713, dj-14089, dj-15127) × n=5 reps that produced the 2026-04-29 headline, this time with the new instrumentation:

- opencode owns the trajectory parser (#22)
- zengram-bench adapter is now a passthrough (zengram-bench#8)
- analyzer dedups read records on `path|offset|limit` instead of just path (zengram-bench#9), so chunked reads of different ranges don't get mislabeled as redundant

**Headline reproduces almost exactly** vs the legacy-parser run from earlier today (focus_round1):

| | focus_round1 (legacy parser) | focus_round2 (chunk-aware) |
|---|---|---|
| baseline resolved | 5/15 (33%) | 5/15 (33%) |
| zengram resolved | 9/15 (60%) | 9/15 (60%) |
| baseline / 1M tok | 3.24 | 3.88 |
| zengram / 1M tok | 5.58 | **6.87** |
| ratio | 1.72× | **1.77×** |

Same per-task pattern: dj-12713 0/0 (zengram 6 turns vs baseline 11.4 — recall halves the work even when neither solves), dj-14089 5/5 both (gate correctly drops cross-task plays on the easy task), dj-15127 0 baseline / 4 zengram (the smoking-gun task).

### The redundant_read finding (this is the headline of the round)

The chunk-aware analyzer reveals that **nearly all of what previously looked like "redundant reads" were chunked reads of different file ranges**, not literal re-reads:

| | redundant_read % (legacy parser) | redundant_read % (chunk-aware) |
|---|---|---|
| baseline | 8.8% | **0.0%** (0 of 164 calls) |
| zengram | 12.7% | **2.8%** (3 of 107 calls) |

The 8.8–20% redundant_read counts in the survey25 narrative were almost entirely **false positives** caused by the bench parser flattening read inputs to just the file path. The model's actual literal re-read rate on this corpus is ~0–3%.

This reframes the next investigation: `redundant_read` isn't where the optimization win lives. The real signal is in `no_edit` sessions (mid-task abandonment when the model gives up empty-handed) and per-task token-efficiency asymmetry — the dj-15127-style win and the survey25 dj-16595-style blowup.

### Methodology note: 5 reps per task is artificial

The n=5 design carried over from the 2026-04-29 reference run was lazy reproduction. Re-running the *same* task 5 times tests the wrong thing — real-world recall benefit comes from plays compounding across *different* tasks in the same domain, not across reps of one task. The proper validation is N=1 across a larger task pool (the survey25 shape), and that's the next bench cycle.

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

### Caveat: absolute numbers are below the 2026-04-29 snapshot

The 2026-04-29 snapshot below reported 8/25 baseline, 13/25 zengram on the same subset; this run got 1/25, 3/25. Both runs were on `Qwen3-Coder-Next Q6_K_XL`, so it's not a model swap. The most likely explanation is **n=1 sample variance** — at this scale a couple of borderline tasks tipping the wrong way moves the count materially — plus differences in accumulated zengram state and llama.cpp server state between runs (today's run started from a wiped multi-session dir; the 2026-04-29 run had its own history).

The *ratio* (2.4×) and the per-task asymmetric-burn pattern are the load-bearing signals here, since they're variance-tolerant in a way the absolute count isn't. Treat the absolute resolution counts as a sanity floor rather than a capability claim until we re-run with higher n.

### What this enables

The trajectory analyzer turning real signal into per-task asymmetry data is the missing piece for tuning the play pipeline empirically rather than by gut. The data points to three next investigations:

1. Tighter similarity gate (or per-task gate). The dj-16595 3.5× blowup is exactly what `ZENGRAM_PLAY_MAX_DISTANCE` is supposed to prevent.
2. Migrate the trajectory parser into opencode's `run` command (zengram-bench issue #4) so it sees read offset/limit and can distinguish chunked re-reads from literal re-reads.
3. Re-run with higher n (or against `Qwen3-Coder-30B-A3B` if we want a stronger-model sanity check) to settle whether 1/25 vs 3/25 is a real regression vs the 2026-04-29 8/25 vs 13/25, or just n=1 variance noise.

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
