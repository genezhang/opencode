import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./forget.txt"
import { forgetFact } from "@/knowledge"

const parameters = z.object({
  id: z.string().describe("Knowledge ID to forget (e.g. 'knw_...')"),
  superseded_by: z.string().optional().describe("ID of the new fact that replaces this one, if any"),
})

type Metadata = { forgotten: boolean }

export const ForgetTool = Tool.define<typeof parameters, Metadata>(
  "zengram_forget",
  async () => ({
    description: DESCRIPTION,
    parameters,
    async execute(params) {
      const ok = await forgetFact({ id: params.id, supersededBy: params.superseded_by })
      return {
        title: `forget: ${params.id}`,
        output: ok ? `Fact ${params.id} marked as ${params.superseded_by ? "superseded" : "inactive"}.` : `Fact ${params.id} not found.`,
        metadata: { forgotten: ok },
      }
    },
  } satisfies Tool.Def<typeof parameters, Metadata>),
)
