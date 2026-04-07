import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./remember.txt"
import { learnFact } from "@/knowledge"
import { Instance } from "@/project/instance"

const parameters = z.object({
  subject: z.string().describe("Short noun phrase identifying the fact (e.g. 'Error handling convention')"),
  content: z.string().describe("Concise, self-contained statement of the fact (1-3 sentences)"),
  scope: z.string().default("/project").describe('Scope: "/" for global, "/project" for this project'),
})

type Metadata = { knowledgeId: string; isNew: boolean }

export const RememberTool = Tool.define<typeof parameters, Metadata>(
  "zengram_remember",
  async () => ({
    description: DESCRIPTION,
    parameters,
    async execute(params, ctx) {
      const { id, isNew } = await learnFact({
        projectId: Instance.project.id,
        scope: params.scope,
        subject: params.subject,
        content: params.content,
        sourceSession: ctx.sessionID,
        sourceTurn: ctx.messageID,
      })

      const status = isNew ? "stored" : "already known (updated access count)"
      return {
        title: `remember: ${params.subject}`,
        output: `Knowledge ${status}. ID: ${id}`,
        metadata: { knowledgeId: id, isNew },
      }
    },
  } satisfies Tool.Def<typeof parameters, Metadata>),
)
