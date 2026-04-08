/**
 * Shared LLM prompt constants for knowledge extraction and reflection.
 * Used by both the passive extraction pipeline (knowledge/index.ts) and
 * the Zengram SDK LlmAdapter implementation (knowledge/adapter.ts) so they
 * stay in sync.
 */

export const EXTRACT_FACTS_SYSTEM_PROMPT =
  "Extract up to 5 durable, project-specific facts from this AI assistant message. " +
  "Return a JSON array of objects with 'subject' (< 60 chars, a short title) and " +
  "'content' (< 200 chars, the complete fact). Only include normative, reusable facts — " +
  "conventions, constraints, patterns, rules. Return [] if none qualify. " +
  "Respond with raw JSON only, no markdown fences."

export const REFLECT_SYSTEM_PROMPT =
  "You are synthesizing a knowledge base for an AI coding agent. " +
  "Given a list of known facts, identify 1-3 higher-level principles or patterns " +
  "that are implied but not explicitly stated. " +
  "Return a JSON array of objects with 'subject' (< 60 chars) and 'content' (< 200 chars). " +
  "Return [] if no meaningful synthesis is possible. Raw JSON only, no markdown."
