import { NamedError } from "@opencode-ai/util/error"
import z from "zod"

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)
