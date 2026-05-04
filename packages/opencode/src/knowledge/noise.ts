/**
 * Reasoning-noise predicate — kept in its own leaf module so probe scripts
 * (script/probe-noise-purge.ts) can import the helper without dragging in
 * knowledge/index.ts and the rest of the runtime (Provider, agent, …).
 *
 * Round2 bench surfaced ~46% of /project facts as raw LLM reasoning rather
 * than durable claims — subjects like "Now I understand the issue", "Let me
 * look at...", "Now I'll fix..." pass the LLM extractor unchecked and
 * pollute every recall regardless of distance gating. This regex catches
 * those leading-reasoning patterns regardless of extraction source.
 */

// First-person reasoning / narration openers that look like facts but are
// just the assistant talking about its own thinking. Reject any subject /
// content matching these patterns.
export const REASONING_NOISE_RE =
  /^(?:\*{0,2})(now\s+(?:i|let)|let\s+me|let's|i(?:'ll|'m| (?:see|can|need|will|understand|think|believe|notice|realize))|looking at|i see|perfect[!.]|great[!.]|the (?:problem|issue|bug|fix) (?:is|seems|appears|looks|here|now)|so |actually,|wait,|hmm,|first,|then,|next,|after that)/i

/**
 * Test whether a string looks like first-person reasoning / narration rather
 * than a durable fact. Used both at extraction time (knowledge/index.ts) and
 * by the probe / purge maintenance helper.
 */
export function looksLikeReasoning(text: string): boolean {
  return REASONING_NOISE_RE.test(text.trim())
}
