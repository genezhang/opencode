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
  "conventions, constraints, patterns, rules.\n\n" +
  "REJECT: subjects/contents that are first-person reasoning, narration, or " +
  "exploratory language. Examples to reject (do NOT extract these): " +
  "\"Now I understand…\", \"Let me look at…\", \"Now I can see the issue\", " +
  "\"Perfect! Now I…\", \"Looking at the test file\", \"The problem is in X\", " +
  "\"I'll fix the issue by…\". These describe what the assistant did, not a " +
  "durable fact about the project.\n" +
  "ACCEPT: imperative or normative claims about the codebase that would help " +
  "a future session. Examples to accept: \"Use conditional_escape for HTML " +
  "output\", \"Auth migrations must run before user_setup\", \"PK identity " +
  "is preserved across multi-table inheritance\".\n" +
  "Subject MUST start with an imperative verb (Use, Avoid, Prefer, Don't, " +
  "Always, Never, Make, Ensure, Keep, Return, Handle, Check, Wrap, Implement, " +
  "Treat, Apply) or a noun phrase describing a stable concept. " +
  "Return [] if none qualify. Respond with raw JSON only, no markdown fences."

export const REFLECT_SYSTEM_PROMPT =
  "You are synthesizing a knowledge base for an AI coding agent. " +
  "Given a list of known facts, identify 1-3 higher-level principles or patterns " +
  "that are implied but not explicitly stated. " +
  "Return a JSON array of objects with 'subject' (< 60 chars) and 'content' (< 200 chars). " +
  "Return [] if no meaningful synthesis is possible. Raw JSON only, no markdown."
