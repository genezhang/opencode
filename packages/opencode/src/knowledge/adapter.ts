/**
 * OpenCode implementation of the Zengram LlmAdapter interface.
 *
 * Routes extraction and reflection calls through OpenCode's existing provider
 * infrastructure (Provider.getSmallModel + ai.generateText).
 */

import { generateText } from "ai"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import { llm } from "@zengram/sdk"

const log = Log.create({ service: "knowledge.adapter" })

class OpenCodeLlmAdapter implements llm.LlmAdapter {
  async extractFacts(text: string): Promise<llm.ExtractedFact[]> {
    try {
      const modelRef = await Provider.defaultModel()
      const smallModel = await Provider.getSmallModel(modelRef.providerID)
      const fullModel = smallModel ?? (await Provider.getModel(modelRef.providerID, modelRef.modelID))
      const language = await Provider.getLanguage(fullModel)

      const { text: output } = await generateText({
        model: language,
        system:
          "Extract up to 5 durable, project-specific facts from this AI assistant message. " +
          "Return a JSON array of objects with 'subject' (< 60 chars) and " +
          "'content' (< 200 chars). Only include normative, reusable facts — " +
          "conventions, constraints, patterns, rules. Return [] if none qualify. " +
          "Respond with raw JSON only, no markdown fences.",
        prompt: text.slice(0, 4000),
      })

      const cleaned = output.replace(/^```json\s*/m, "").replace(/```\s*$/m, "").trim()
      const parsed = JSON.parse(cleaned)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (f): f is llm.ExtractedFact =>
          typeof f?.subject === "string" && typeof f?.content === "string",
      )
    } catch (e) {
      log.warn("extractFacts failed", { err: e })
      return []
    }
  }

  async reflect(facts: llm.ExtractedFact[]): Promise<llm.ReflectionInsight[]> {
    if (facts.length < 3) return []
    try {
      const modelRef = await Provider.defaultModel()
      const smallModel = await Provider.getSmallModel(modelRef.providerID)
      const fullModel = smallModel ?? (await Provider.getModel(modelRef.providerID, modelRef.modelID))
      const language = await Provider.getLanguage(fullModel)

      const factList = facts
        .slice(0, 20)
        .map((f) => `- ${f.subject}: ${f.content}`)
        .join("\n")

      const { text: output } = await generateText({
        model: language,
        system:
          "You are synthesizing a knowledge base for an AI coding agent. " +
          "Given a list of known facts, identify 1-3 higher-level principles or patterns " +
          "that are implied but not explicitly stated. " +
          "Return a JSON array of objects with 'subject' (< 60 chars) and 'content' (< 200 chars). " +
          "Return [] if no meaningful synthesis is possible. Raw JSON only, no markdown.",
        prompt: `Known facts:\n${factList}`,
      })

      const cleaned = output.replace(/^```json\s*/m, "").replace(/```\s*$/m, "").trim()
      const parsed = JSON.parse(cleaned)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (f): f is llm.ReflectionInsight =>
          typeof f?.subject === "string" && typeof f?.content === "string",
      )
    } catch (e) {
      log.warn("reflect failed", { err: e })
      return []
    }
  }
}

/** Register OpenCode's provider as the Zengram LLM adapter. Call once at startup. */
export function registerLlmAdapter(): void {
  llm.setLlmAdapter(new OpenCodeLlmAdapter())
}
