# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repo is a **fork of [opencode](https://github.com/sst/opencode)**. Upstream OpenCode is an open-source AI-powered development tool (CLI, web, desktop) — a Bun/Turbo monorepo. We use it as a concrete testbed; our fork has a different mission.

### Why this fork exists

**Goal:** replace OpenCode's memory/storage layer (SQLite + Drizzle) with **Zengram**, a purpose-built agent database framework, to give agentic workflows a substrate that SQLite was never designed for (facts, knowledge, workspace context, recall, decay, cross-session continuity).

Coding agents are the **first testbed** for Zengram, and OpenCode is the concrete repo where we prove it out end-to-end. See `memory/project_zengram.md` for design context.

### Current status — honest

We are **far from the goal**. Initial `zengram-bench` runs show Zengram-enabled sessions **burn more tokens without a quality gain** versus the SQLite baseline. The optimization target is clear:

- **Reduce turns** required to complete a task.
- **Reduce tokens** per turn (recall should pay for itself).
- Match or beat the SQLite baseline's output quality.

Improvements are needed on **both sides**:
- **Zengram side** — better recall signal, cheaper queries, tighter prompts for reflection/extraction, less noise in workspace context.
- **OpenCode side** — smarter injection of Zengram context (when to recall, how much to include, how to avoid re-sending stale facts), tool-call patterns that exploit persistent memory instead of re-deriving state.

When proposing changes in this repo, ask: *does this move the turn count or token count in the right direction, and if not, what does it buy us?*

## Essential Commands

```bash
bun install                    # Install dependencies
bun dev                        # Run TUI (defaults to packages/opencode dir)
bun dev <directory>            # Run TUI against a specific directory
bun dev .                      # Run TUI against repo root
bun dev serve                  # Start headless API server (port 4096)
bun dev web                    # Start server + open web interface
bun turbo typecheck            # Typecheck all packages
```

**Tests** — must run from package directories, never from repo root:
```bash
cd packages/opencode && bun test                    # Run all tests
cd packages/opencode && bun test test/foo.test.ts   # Run single test
```

**Typecheck** — run from package directories using the package script, never `tsc` directly:
```bash
cd packages/opencode && bun typecheck   # Uses tsgo --noEmit
```

**Build standalone binary:**
```bash
./packages/opencode/script/build.ts --single
```

**Regenerate JS SDK** (after API/server changes):
```bash
./packages/sdk/js/script/build.ts
```

**Web app dev** (requires server running separately via `bun dev serve`):
```bash
bun run --cwd packages/app dev
```

**Database migrations:**
```bash
cd packages/opencode && bun drizzle-kit <command>
```

## Code Style (Mandatory)

Refer to `AGENTS.md` for the full style guide. Key rules:

- **Single-word names** for variables, params, helpers. Multi-word only when ambiguous. Good: `pid`, `cfg`, `err`, `opts`, `dir`. Bad: `inputPID`, `existingClient`.
- **Inline single-use values** — reduce variable count.
- **No destructuring** — use dot notation (`obj.a` not `const { a } = obj`).
- **`const` over `let`** — use ternaries or early returns instead of reassignment.
- **No `else`** — use early returns.
- **No `try`/`catch`** — use Effect for error handling.
- **No `any`** — use precise types.
- **Bun APIs** — prefer `Bun.file()` etc. when possible.
- **Functional array methods** — `flatMap`, `filter`, `map` over `for` loops.
- **Drizzle schemas** — use snake_case field names so column names don't need redeclaring.
- **Prettier** — semicolons off, printWidth 120.

## Architecture

### Monorepo Layout

- `packages/opencode` — Core CLI, server, and business logic (the main package)
- `packages/app` — Shared web UI (SolidJS + Vite + Tailwind)
- `packages/desktop` — Native desktop app (Tauri wrapping `packages/app`)
- `packages/ui` — Reusable UI components (SolidJS + Kobalte)
- `packages/sdk/js` — JavaScript SDK (generated from OpenAPI spec)
- `packages/plugin` — Plugin system (`@opencode-ai/plugin`)
- `packages/console/*` — Console web interface and backend

### Tech Stack

- **Runtime**: Bun 1.3.10
- **Language**: TypeScript 5.8.2
- **Core framework**: Effect 4.x (functional programming, DI, error handling)
- **Web framework**: Hono (API server)
- **Database**: SQLite via Drizzle ORM
- **Frontend**: SolidJS (web, desktop, TUI via opentui)
- **AI**: Vercel AI SDK (`ai` package) with 15+ provider adapters
- **MCP**: `@modelcontextprotocol/sdk` for tool/resource definitions
- **Build**: Turbo for task orchestration

### Effect Service Pattern

The codebase uses Effect's service architecture. Services use `ServiceMap.Service<Interface, Implementation>` and are composed via Layers. The `makeRunPromise` helper in `packages/opencode/src/effect/run-service.ts` creates runtime executors for Effect services.

Key source directories in `packages/opencode/src/`:
- `effect/` — Service infrastructure (registry, state, context, runtime helpers)
- `provider/` — LLM provider integration
- `session/` — Session management
- `tool/` — Tool definitions
- `mcp/` — Model Context Protocol
- `cli/cmd/` — CLI commands
- `cli/cmd/tui/` — Terminal UI (SolidJS + opentui)
- `server/` — Hono API server
- `storage/` — Database layer (Drizzle + SQLite)
- `permission/` — Permission/security system

### Conditional Imports

`packages/opencode` uses Bun's conditional imports for platform-specific code:
- `#db` resolves to `db.bun.ts` or `db.node.ts` based on runtime
- The `--conditions=browser` flag is used during dev for TUI rendering

### Pre-push Hook

Husky pre-push hook verifies Bun version matches `package.json` and runs `bun typecheck`.

## Branch Convention

This fork inverts upstream's branch layout:

- **`origin/main` is our default branch.** PRs in this fork target `main`. Day-to-day work, diffs, and releases are all against `main`.
- **`origin/dev` is the upstream tracking branch** (the default branch of `sst/opencode`). We pull from it to absorb upstream changes — but upstream merges frequently and **we do not try to keep up with every merge**. Sync from `dev` deliberately, not continuously.
- When diffing "what changed in our fork," compare against **`origin/main`**, not `origin/dev`.
- When diffing "what's new upstream that we haven't pulled," compare `origin/dev` against our last sync point.
- Local `main` may be ahead of `origin/dev` by a large number of commits — that is expected, not a mistake.

## PR Conventions

PR titles use conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`. Optional scope: `feat(app):`, `fix(desktop):`, `feat(zengram):`.

PRs target **`main`** (our fork's default), not `dev` (upstream).
