import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { Flag } from "../../flag/flag"
import { bootstrap } from "../bootstrap"
import { EOL, homedir } from "os"
import { Filesystem } from "../../util/filesystem"
import { createOpencodeClient, type Message, type OpencodeClient, type ToolPart } from "@opencode-ai/sdk/v2"
import { Server } from "../../server/server"
import { Provider } from "../../provider/provider"
import { Agent } from "../../agent/agent"
import { Permission } from "../../permission"
import { Tool } from "../../tool/tool"
import { GlobTool } from "../../tool/glob"
import { GrepTool } from "../../tool/grep"
import { ListTool } from "../../tool/ls"
import { ReadTool } from "../../tool/read"
import { WebFetchTool } from "../../tool/webfetch"
import { EditTool } from "../../tool/edit"
import { WriteTool } from "../../tool/write"
import { CodeSearchTool } from "../../tool/codesearch"
import { WebSearchTool } from "../../tool/websearch"
import { TaskTool } from "../../tool/task"
import { SkillTool } from "../../tool/skill"
import { BashTool } from "../../tool/bash"
import { TodoWriteTool } from "../../tool/todo"
import { Locale } from "../../util/locale"

type ToolProps<T> = {
  input: Tool.InferParameters<T>
  metadata: Tool.InferMetadata<T>
  part: ToolPart
}

function props<T>(part: ToolPart): ToolProps<T> {
  const state = part.state
  return {
    input: state.input as Tool.InferParameters<T>,
    metadata: ("metadata" in state ? state.metadata : {}) as Tool.InferMetadata<T>,
    part,
  }
}

type Inline = {
  icon: string
  title: string
  description?: string
}

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

function fallback(part: ToolPart) {
  const state = part.state
  const input = "input" in state ? state.input : undefined
  const title =
    ("title" in state && state.title ? state.title : undefined) ||
    (input && typeof input === "object" && Object.keys(input).length > 0 ? JSON.stringify(input) : "Unknown")
  inline({
    icon: "⚙",
    title: `${part.tool} ${title}`,
  })
}

function glob(info: ToolProps<typeof GlobTool>) {
  const root = info.input.path ?? ""
  const title = `Glob "${info.input.pattern}"`
  const suffix = root ? `in ${normalizePath(root)}` : ""
  const num = info.metadata.count
  const description =
    num === undefined ? suffix : `${suffix}${suffix ? " · " : ""}${num} ${num === 1 ? "match" : "matches"}`
  inline({
    icon: "✱",
    title,
    ...(description && { description }),
  })
}

function grep(info: ToolProps<typeof GrepTool>) {
  const root = info.input.path ?? ""
  const title = `Grep "${info.input.pattern}"`
  const suffix = root ? `in ${normalizePath(root)}` : ""
  const num = info.metadata.matches
  const description =
    num === undefined ? suffix : `${suffix}${suffix ? " · " : ""}${num} ${num === 1 ? "match" : "matches"}`
  inline({
    icon: "✱",
    title,
    ...(description && { description }),
  })
}

function list(info: ToolProps<typeof ListTool>) {
  const dir = info.input.path ? normalizePath(info.input.path) : ""
  inline({
    icon: "→",
    title: dir ? `List ${dir}` : "List",
  })
}

function read(info: ToolProps<typeof ReadTool>) {
  const file = normalizePath(info.input.filePath)
  const pairs = Object.entries(info.input).filter(([key, value]) => {
    if (key === "filePath") return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  const description = pairs.length ? `[${pairs.map(([key, value]) => `${key}=${value}`).join(", ")}]` : undefined
  inline({
    icon: "→",
    title: `Read ${file}`,
    ...(description && { description }),
  })
}

function write(info: ToolProps<typeof WriteTool>) {
  block(
    {
      icon: "←",
      title: `Write ${normalizePath(info.input.filePath)}`,
    },
    info.part.state.status === "completed" ? info.part.state.output : undefined,
  )
}

function webfetch(info: ToolProps<typeof WebFetchTool>) {
  inline({
    icon: "%",
    title: `WebFetch ${info.input.url}`,
  })
}

function edit(info: ToolProps<typeof EditTool>) {
  const title = normalizePath(info.input.filePath)
  const diff = info.metadata.diff
  block(
    {
      icon: "←",
      title: `Edit ${title}`,
    },
    diff,
  )
}

function codesearch(info: ToolProps<typeof CodeSearchTool>) {
  inline({
    icon: "◇",
    title: `Exa Code Search "${info.input.query}"`,
  })
}

function websearch(info: ToolProps<typeof WebSearchTool>) {
  inline({
    icon: "◈",
    title: `Exa Web Search "${info.input.query}"`,
  })
}

function task(info: ToolProps<typeof TaskTool>) {
  const input = info.part.state.input
  const status = info.part.state.status
  const subagent =
    typeof input.subagent_type === "string" && input.subagent_type.trim().length > 0 ? input.subagent_type : "unknown"
  const agent = Locale.titlecase(subagent)
  const desc =
    typeof input.description === "string" && input.description.trim().length > 0 ? input.description : undefined
  const icon = status === "error" ? "✗" : status === "running" ? "•" : "✓"
  const name = desc ?? `${agent} Task`
  inline({
    icon,
    title: name,
    description: desc ? `${agent} Agent` : undefined,
  })
}

function skill(info: ToolProps<typeof SkillTool>) {
  inline({
    icon: "→",
    title: `Skill "${info.input.name}"`,
  })
}

function bash(info: ToolProps<typeof BashTool>) {
  const output = info.part.state.status === "completed" ? info.part.state.output?.trim() : undefined
  block(
    {
      icon: "$",
      title: `${info.input.command}`,
    },
    output,
  )
}

function todo(info: ToolProps<typeof TodoWriteTool>) {
  block(
    {
      icon: "#",
      title: "Todos",
    },
    info.input.todos.map((item) => `${item.status === "completed" ? "[x]" : "[ ]"} ${item.content}`).join("\n"),
  )
}

function normalizePath(input?: string) {
  if (!input) return ""
  if (path.isAbsolute(input)) return path.relative(process.cwd(), input) || "."
  return input
}

export const RunCommand = cmd({
  command: "run [message..]",
  describe: "run opencode with a message",
  builder: (yargs: Argv) => {
    return yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      .option("share", {
        type: "boolean",
        describe: "share the session",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running opencode server (e.g., http://localhost:4096)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
      })
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
        default: false,
      })
      .option("trajectory-json", {
        type: "string",
        describe:
          "write a trajectory summary (tool calls, files touched, per-call records) to this path on session end",
      })
  },
  handler: async (args) => {
    let message = [...args.message, ...(args["--"] || [])]
      .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
      .join(" ")

    const directory = (() => {
      if (!args.dir) return undefined
      if (args.attach) return args.dir
      try {
        process.chdir(args.dir)
        return process.cwd()
      } catch {
        UI.error("Failed to change directory to " + args.dir)
        process.exit(1)
      }
    })()

    const files: { type: "file"; url: string; filename: string; mime: string }[] = []
    if (args.file) {
      const list = Array.isArray(args.file) ? args.file : [args.file]

      for (const filePath of list) {
        const resolvedPath = path.resolve(process.cwd(), filePath)
        if (!(await Filesystem.exists(resolvedPath))) {
          UI.error(`File not found: ${filePath}`)
          process.exit(1)
        }

        const mime = (await Filesystem.isDir(resolvedPath)) ? "application/x-directory" : "text/plain"

        files.push({
          type: "file",
          url: pathToFileURL(resolvedPath).href,
          filename: path.basename(resolvedPath),
          mime,
        })
      }
    }

    if (!process.stdin.isTTY) message += "\n" + (await Bun.stdin.text())

    if (message.trim().length === 0 && !args.command) {
      UI.error("You must provide a message or a command")
      process.exit(1)
    }

    if (args.fork && !args.continue && !args.session) {
      UI.error("--fork requires --continue or --session")
      process.exit(1)
    }

    const rules: Permission.Ruleset = [
      {
        permission: "question",
        action: "deny",
        pattern: "*",
      },
      {
        permission: "plan_enter",
        action: "deny",
        pattern: "*",
      },
      {
        permission: "plan_exit",
        action: "deny",
        pattern: "*",
      },
    ]

    function title() {
      if (args.title === undefined) return
      if (args.title !== "") return args.title
      return message.slice(0, 50) + (message.length > 50 ? "..." : "")
    }

    async function session(sdk: OpencodeClient) {
      const baseID = args.continue ? (await sdk.session.list()).data?.find((s) => !s.parentID)?.id : args.session

      if (baseID && args.fork) {
        const forked = await sdk.session.fork({ sessionID: baseID })
        return forked.data?.id
      }

      if (baseID) return baseID

      const name = title()
      const result = await sdk.session.create({ title: name, permission: rules })
      return result.data?.id
    }

    async function share(sdk: OpencodeClient, sessionID: string) {
      const cfg = await sdk.config.get()
      if (!cfg.data) return
      if (cfg.data.share !== "auto" && !Flag.OPENCODE_AUTO_SHARE && !args.share) return
      const res = await sdk.session.share({ sessionID }).catch((error) => {
        if (error instanceof Error && error.message.includes("disabled")) {
          UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + error.message)
        }
        return { error }
      })
      if (!res.error && "data" in res && res.data?.share?.url) {
        UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + res.data.share.url)
      }
    }

    async function execute(sdk: OpencodeClient) {
      function tool(part: ToolPart) {
        try {
          if (part.tool === "bash") return bash(props<typeof BashTool>(part))
          if (part.tool === "glob") return glob(props<typeof GlobTool>(part))
          if (part.tool === "grep") return grep(props<typeof GrepTool>(part))
          if (part.tool === "list") return list(props<typeof ListTool>(part))
          if (part.tool === "read") return read(props<typeof ReadTool>(part))
          if (part.tool === "write") return write(props<typeof WriteTool>(part))
          if (part.tool === "webfetch") return webfetch(props<typeof WebFetchTool>(part))
          if (part.tool === "edit") return edit(props<typeof EditTool>(part))
          if (part.tool === "codesearch") return codesearch(props<typeof CodeSearchTool>(part))
          if (part.tool === "websearch") return websearch(props<typeof WebSearchTool>(part))
          if (part.tool === "task") return task(props<typeof TaskTool>(part))
          if (part.tool === "todowrite") return todo(props<typeof TodoWriteTool>(part))
          if (part.tool === "skill") return skill(props<typeof SkillTool>(part))
          return fallback(part)
        } catch {
          return fallback(part)
        }
      }

      function emit(type: string, data: Record<string, unknown>) {
        if (args.format === "json") {
          process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + EOL)
          return true
        }
        return false
      }

      // Trajectory accumulator — populated by the loop below as tool calls
      // resolve. Mirrors the schema zengram-bench reconstructs from the
      // JSONL stream today; difference is each record carries the raw
      // `input` object so downstream analyzers can see fields the bench
      // parser had to flatten away (read offset/limit, multiedit edits[],
      // etc.). Written only when --trajectory-json is set.
      type TrajectoryRecord = {
        turn: number
        tool: string
        input_summary: string
        status: "completed" | "error"
        duration_ms: number
        output_chars: number
        input: Record<string, unknown>
      }
      const trajectoryEnabled = !!args["trajectory-json"]
      const toolCounts: Record<string, number> = {}
      const filesTouched = new Map<string, { reads: number; edits: number }>()
      const bashCommands: string[] = []
      const records: TrajectoryRecord[] = []
      let currentTurn = 0

      function fileTouch(p: string) {
        let entry = filesTouched.get(p)
        if (!entry) {
          entry = { reads: 0, edits: 0 }
          filesTouched.set(p, entry)
        }
        return entry
      }

      function summarizeInput(tool: string, input: Record<string, unknown>): string {
        const fp = (typeof input.filePath === "string" ? input.filePath : undefined) ??
          (typeof input.path === "string" ? input.path : undefined)
        if ((tool === "read" || tool === "edit" || tool === "write") && fp) return `path=${fp}`
        if (tool === "bash") {
          const cmd = typeof input.command === "string" ? input.command.slice(0, 80) : ""
          return `cmd=${cmd}`
        }
        if (tool === "grep") {
          const pat = typeof input.pattern === "string" ? input.pattern : ""
          const where = typeof input.path === "string" ? input.path :
            typeof input.include === "string" ? input.include : ""
          return `pattern=${pat} path=${where}`.trim()
        }
        if (tool === "glob") return `pattern=${typeof input.pattern === "string" ? input.pattern : ""}`
        if (tool === "codesearch")
          return `q=${typeof input.query === "string" ? input.query : (typeof input.q === "string" ? input.q : "")}`
        if (tool === "webfetch") return `url=${typeof input.url === "string" ? input.url : ""}`
        return `keys=${Object.keys(input).filter((k) => !k.startsWith("_")).sort().join(",").slice(0, 80)}`
      }

      function recordToolCall(part: ToolPart) {
        if (!trajectoryEnabled) return
        const tool = part.tool
        const state = part.state
        if (state.status !== "completed" && state.status !== "error") return
        const input = (state.input ?? {}) as Record<string, unknown>
        const t = (state as unknown as { time?: { start?: number; end?: number } }).time ?? {}
        // Explicit `typeof === "number"` checks rather than truthiness so a
        // legitimate 0 timestamp (mocked clock, tool emitting epoch-relative
        // 0-based timestamps) doesn't get silently treated as "missing" and
        // collapsed to a 0 duration when it should be undefined-handled.
        const dur =
          typeof t.start === "number" && typeof t.end === "number"
            ? Math.max(0, t.end - t.start)
            : 0
        const output = state.status === "completed" ? (state as unknown as { output?: string }).output ?? "" : ""
        toolCounts[tool] = (toolCounts[tool] ?? 0) + 1
        records.push({
          turn: Math.max(currentTurn, 1),
          tool,
          input_summary: summarizeInput(tool, input),
          status: state.status,
          duration_ms: dur,
          output_chars: typeof output === "string" ? output.length : 0,
          input,
        })
        const fp = (typeof input.filePath === "string" ? input.filePath : undefined) ??
          (typeof input.path === "string" ? input.path : undefined)
        if (tool === "read" && fp) fileTouch(fp).reads++
        else if ((tool === "edit" || tool === "write") && fp) fileTouch(fp).edits++
        else if (tool === "apply_patch" && state.status === "completed") {
          // apply_patch is the codebase's primary patch-based editor (see
          // ToolRegistry filtering); its completed-state metadata exposes a
          // `files: [{filePath, type, ...}]` array. Surface those edits in
          // files_touched so trajectories from apply_patch sessions don't
          // misleadingly read as "no files touched". `type === "delete"`
          // still counts as an edit (the file was modified — removed).
          const meta = (state as unknown as { metadata?: { files?: Array<{ filePath?: string }> } }).metadata
          for (const f of meta?.files ?? []) {
            if (typeof f.filePath === "string" && f.filePath) fileTouch(f.filePath).edits++
          }
        } else if (tool === "bash" && typeof input.command === "string") {
          const cmd = input.command.slice(0, 80)
          if (cmd) bashCommands.push(cmd)
        }
      }

      async function writeTrajectoryIfRequested() {
        const raw = args["trajectory-json"] as string | undefined
        if (!raw) return
        // Expand `~/` and `$HOME` so quoted args / Windows shells / contexts
        // where the shell didn't expand the tilde all work consistently with
        // the rest of the codebase (config/paths.ts, permission/index.ts,
        // tool/bash.ts:119, etc.).
        const out = expandHome(raw)
        const filesArr = [...filesTouched.entries()]
          .map(([p, v]) => ({ path: p, ...v }))
          .sort((a, b) => (b.reads + b.edits) - (a.reads + a.edits))
        const payload = {
          tool_counts: toolCounts,
          files_touched: filesArr,
          bash_commands: bashCommands,
          records,
        }
        try {
          // Filesystem.write auto-creates parent directories on ENOENT so
          // `--trajectory-json some/missing/dir/out.json` works. Centralises
          // I/O on the codebase's helper rather than reaching for Bun.write
          // directly.
          await Filesystem.write(out, JSON.stringify(payload))
        } catch (e) {
          // Don't fail the run if trajectory write fails — log and continue.
          UI.error(`failed to write trajectory: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      function expandHome(p: string): string {
        if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir(), p.slice(2))
        if (p === "~") return homedir()
        if (p.startsWith("$HOME/") || p.startsWith("$HOME\\")) return path.join(homedir(), p.slice(6))
        return p
      }

      const events = await sdk.event.subscribe()
      let error: string | undefined

      async function loop() {
        const toggles = new Map<string, boolean>()

        for await (const event of events.stream) {
          if (
            event.type === "message.updated" &&
            event.properties.info.role === "assistant" &&
            args.format !== "json" &&
            toggles.get("start") !== true
          ) {
            UI.empty()
            UI.println(`> ${event.properties.info.agent} · ${event.properties.info.modelID}`)
            UI.empty()
            toggles.set("start", true)
          }

          if (event.type === "message.part.updated") {
            const part = event.properties.part
            if (part.sessionID !== sessionID) continue

            if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
              recordToolCall(part)
              if (emit("tool_use", { part })) continue
              if (part.state.status === "completed") {
                tool(part)
                continue
              }
              inline({
                icon: "✗",
                title: `${part.tool} failed`,
              })
              UI.error(part.state.error)
            }

            if (
              part.type === "tool" &&
              part.tool === "task" &&
              part.state.status === "running" &&
              args.format !== "json"
            ) {
              if (toggles.get(part.id) === true) continue
              task(props<typeof TaskTool>(part))
              toggles.set(part.id, true)
            }

            if (part.type === "step-start") {
              currentTurn++
              if (emit("step_start", { part })) continue
            }

            if (part.type === "step-finish") {
              if (emit("step_finish", { part })) continue
            }

            if (part.type === "text" && part.time?.end) {
              if (emit("text", { part })) continue
              const text = part.text.trim()
              if (!text) continue
              if (!process.stdout.isTTY) {
                process.stdout.write(text + EOL)
                continue
              }
              UI.empty()
              UI.println(text)
              UI.empty()
            }

            if (part.type === "reasoning" && part.time?.end && args.thinking) {
              if (emit("reasoning", { part })) continue
              const text = part.text.trim()
              if (!text) continue
              const line = `Thinking: ${text}`
              if (process.stdout.isTTY) {
                UI.empty()
                UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                UI.empty()
                continue
              }
              process.stdout.write(line + EOL)
            }
          }

          if (event.type === "session.error") {
            const props = event.properties
            if (props.sessionID !== sessionID || !props.error) continue
            let err = String(props.error.name)
            if ("data" in props.error && props.error.data && "message" in props.error.data) {
              err = String(props.error.data.message)
            }
            error = error ? error + EOL + err : err
            if (emit("error", { error: props.error })) continue
            UI.error(err)
          }

          if (
            event.type === "session.status" &&
            event.properties.sessionID === sessionID &&
            event.properties.status.type === "idle"
          ) {
            await writeTrajectoryIfRequested()
            break
          }

          if (event.type === "permission.asked") {
            const permission = event.properties
            if (permission.sessionID !== sessionID) continue
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL +
                `permission requested: ${permission.permission} (${permission.patterns.join(", ")}); auto-rejecting`,
            )
            await sdk.permission.reply({
              requestID: permission.id,
              reply: "reject",
            })
          }
        }
      }

      // Validate agent if specified
      const agent = await (async () => {
        if (!args.agent) return undefined

        // When attaching, validate against the running server instead of local Instance state.
        if (args.attach) {
          const modes = await sdk.app
            .agents(undefined, { throwOnError: true })
            .then((x) => x.data ?? [])
            .catch(() => undefined)

          if (!modes) {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL,
              `failed to list agents from ${args.attach}. Falling back to default agent`,
            )
            return undefined
          }

          const agent = modes.find((a) => a.name === args.agent)
          if (!agent) {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL,
              `agent "${args.agent}" not found. Falling back to default agent`,
            )
            return undefined
          }

          if (agent.mode === "subagent") {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL,
              `agent "${args.agent}" is a subagent, not a primary agent. Falling back to default agent`,
            )
            return undefined
          }

          return args.agent
        }

        const entry = await Agent.get(args.agent)
        if (!entry) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${args.agent}" not found. Falling back to default agent`,
          )
          return undefined
        }
        if (entry.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${args.agent}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }
        return args.agent
      })()

      const sessionID = await session(sdk)
      if (!sessionID) {
        UI.error("Session not found")
        process.exit(1)
      }
      await share(sdk, sessionID)

      // Capture the loop promise instead of fire-and-forget. The loop awaits
      // `writeTrajectoryIfRequested()` on session.status idle, but if we
      // don't await the loop here, execute() returns the moment prompt()
      // resolves and bootstrap's cleanup tears down the process before the
      // trajectory write (especially its auto-mkdir branch on a missing
      // parent dir) finishes its second await. Awaiting the loop ensures
      // file I/O completes before exit.
      const loopP = loop().catch((e) => {
        console.error(e)
        process.exit(1)
      })

      if (args.command) {
        await sdk.session.command({
          sessionID,
          agent,
          model: args.model,
          command: args.command,
          arguments: message,
          variant: args.variant,
        })
      } else {
        const model = args.model ? Provider.parseModel(args.model) : undefined
        await sdk.session.prompt({
          sessionID,
          agent,
          model,
          variant: args.variant,
          parts: [...files, { type: "text", text: message }],
        })
      }
      await loopP
    }

    if (args.attach) {
      const headers = (() => {
        const password = args.password ?? process.env.OPENCODE_SERVER_PASSWORD
        if (!password) return undefined
        const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
        const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
        return { Authorization: auth }
      })()
      const sdk = createOpencodeClient({ baseUrl: args.attach, directory, headers })
      return await execute(sdk)
    }

    await bootstrap(process.cwd(), async () => {
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        return Server.Default().fetch(request)
      }) as typeof globalThis.fetch
      const sdk = createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn })
      await execute(sdk)
    })
  },
})
