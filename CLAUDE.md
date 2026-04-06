# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenCode is an open-source AI-powered development tool (CLI, web, desktop). Monorepo using Bun workspaces and Turbo for orchestration.

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

- Default branch is `dev` (not `main`). Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.

## PR Conventions

PR titles use conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`. Optional scope: `feat(app):`, `fix(desktop):`.
