# Zengram Benchmark Findings — 2026-04-09 Run

Source: `~/zengram-bench/results/runs/` — 7 Django SWE-bench tasks × 3 trials × 2 variants (baseline SQLite vs Zengram), 42 runs, all completed.

## TL;DR

We are burning **~1.85× the total tokens for the same outcome**, entirely on the prompt side. Completion tokens are flat (1.03×). Turn counts are slightly *worse* (+9%), not better. The stated goal of Zengram — persistent memory paying for itself with fewer turns and/or fewer tokens — is currently producing the inverse on every metric.

## Headline Numbers (median per task, summed across 7 tasks)

| metric | baseline (SQLite) | zengram | ratio |
|---|---|---|---|
| prompt tokens | 141,254 | 285,614 | **2.02×** |
| completion tokens | 29,176 | 29,962 | 1.03× |
| total tokens | 170,430 | 315,576 | **1.85×** |
| turns | 129 | 141 | **+9%** |
| completion rate | 100% (21/21) | 100% (21/21) | — |

## Per-Task Breakdown

Ratios are `zengram / baseline` on medians across 3 trials.

| task | B turns | Z turns | B prompt | Z prompt | prompt ratio | total ratio |
|---|---|---|---|---|---|---|
| django-10097 | 30 | 30 | 29,899 | 31,183 | 1.04× | 1.03× |
| django-11099 | 1 | 8 | 0 | 12,593 | — | — |
| django-11211 | 24 | 25 | 26,303 | 54,859 | **2.09×** | 1.90× |
| django-11451 | 12 | 18 | 14,128 | 26,167 | **1.85×** | 1.82× |
| django-11740 | 30 | 30 | 31,229 | 80,388 | **2.57×** | **2.43×** |
| django-11999 | 2 | 13 | 14,599 | 27,777 | 1.90× | 1.99× |
| django-12273 | 30 | 17 | 25,096 | 52,647 | **2.10×** | 1.80× |

Note: `django-11099` baseline reported 1 turn and 0 tokens (appears to be a near-noop resolution); ratio is not meaningful there.

## The Fingerprint: Burn Scales with Turn Count

- Short sessions (`dj-10097`, 30 turns both sides, equal prompt sizes) show ~parity.
- Long sessions (`dj-11740`, 30 turns, 2.57× prompt) show the largest gap.
- This is the classic signature of **per-turn context re-injection** — each additional turn re-pays the cost of the injected block rather than amortizing it via cache.

## Hypothesis: Where the Extra ~145k Prompt Tokens Live

Unverified — needs a session trace to confirm. Candidates, in order of likelihood:

1. **Workspace-context block (`<zengram-workspace>`)** is injected into the system prompt every turn (`knowledge/index.ts:recallWorkspaceContext` + `formatWorkspaceBlock`, wired in `session/prompt.ts` under `ZENGRAM_ENABLED`). It *grows* as files are touched during the session, so each turn's system prompt is strictly larger than the last.
2. **Recalled-facts block** from `recallFacts` is injected on every turn with no deduplication against what the model has already seen earlier in the same session.
3. **Prompt-cache invalidation.** Any system-prompt block whose bytes change turn-to-turn blows past the Anthropic prompt-cache breakpoint above it. The recall math only works if the recall block sits *below* a stable cache boundary. It likely doesn't.

## What the Aggregate Data Cannot Tell Us

- Size of the workspace block per turn (is it 200 tokens or 3,000?).
- Whether the same fact is being recalled across multiple turns in one session.
- Whether workspace-block growth is monotonic or resets.
- Where the cache breakpoint is and whether it's effective.

These need a single-session instrumentation pass.

## Next Step: Instrument dj-11740

Pick the worst case (`django-11740`, 2.57× prompt ratio) and log per-turn:

- Size (chars + estimated tokens) of the `<zengram-workspace>` block.
- Size of the recalled-facts block.
- Full system-prompt size at send time.
- Number of cached vs uncached input tokens reported by the provider.

One instrumented run tells us the mechanism and rules out whichever hypothesis is wrong. Fix proposals stay speculative until that happens.

## What Success Looks Like

For Zengram to justify its existence vs the SQLite baseline, the next bench run should show at least one of:

- **Total tokens ≤ baseline** on long sessions (the structural case for persistent memory).
- **Turns < baseline** on tasks where prior knowledge should shortcut exploration.
- Ideally both, with no quality regression.

Anything less and we are paying for infrastructure without cashing the check.

## Methodology Notes

- Medians used over means (n=3 per task-variant, median is more robust to outliers).
- "Median-sum" = sum of per-task medians. This overweights long tasks by design, which is the right framing: long tasks are where agent memory is *supposed* to win.
- Raw data: `~/zengram-bench/results/runs/*.json`. Re-aggregation is a one-shot script away — no persisted aggregate report yet.
