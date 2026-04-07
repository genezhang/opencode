import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./search.txt"
import { searchFacts, formatKnowledgeBlock } from "@/knowledge"
import { Instance } from "@/project/instance"

const parameters = z.object({
  query: z.string().describe("Keyword or phrase to search for (case-insensitive substring match on subject and content)"),
  limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of results to return"),
})

type Metadata = { count: number }

export const SearchTool = Tool.define<typeof parameters, Metadata>(
  "zengram_search",
  async () => ({
    description: DESCRIPTION,
    parameters,
    async execute(params) {
      const facts = await searchFacts({
        projectId: Instance.project.id,
        query: params.query,
        limit: params.limit,
      })

      const block = formatKnowledgeBlock(facts)
      const output = block
        ? `Found ${facts.length} fact(s):\n\n${block}`
        : `No facts found matching "${params.query}".`

      return {
        title: `search memory: ${params.query}`,
        output,
        metadata: { count: facts.length },
      }
    },
  } satisfies Tool.Def<typeof parameters, Metadata>),
)
