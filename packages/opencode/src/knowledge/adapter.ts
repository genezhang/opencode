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
import { EXTRACT_FACTS_SYSTEM_PROMPT, REFLECT_SYSTEM_PROMPT } from "./prompts"

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
        system: EXTRACT_FACTS_SYSTEM_PROMPT,
        prompt: text.slice(0, 4000),
      })

      const cleaned = output.replace(/^```json\s*/m, "").replace(/```\s*$/m, "").trim()
      const parsed = JSON.parse(cleaned)
      if (!Array.isArray(parsed)) return []
      return parsed
        .filter(
          (f): f is llm.ExtractedFact =>
            typeof f?.subject === "string" && typeof f?.content === "string",
        )
        .slice(0, 5) // enforce prompt's "up to 5" instruction
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
        system: REFLECT_SYSTEM_PROMPT,
        prompt: `Known facts:\n${factList}`,
      })

      const cleaned = output.replace(/^```json\s*/m, "").replace(/```\s*$/m, "").trim()
      const parsed = JSON.parse(cleaned)
      if (!Array.isArray(parsed)) return []
      return parsed
        .filter(
          (f): f is { subject: string; content: string } =>
            typeof f?.subject === "string" && typeof f?.content === "string",
        )
        .map((f) => ({ subject: f.subject.trim(), content: f.content.trim() }))
        .filter((f): f is llm.ReflectionInsight => f.subject.length > 0 && f.content.length > 0)
        .slice(0, 3) // enforce prompt's "1-3" instruction
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
