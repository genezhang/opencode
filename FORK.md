# FORK.md — fork layout & upstream sync

This repo (`genezhang/opencode`) is a fork of **`sst/opencode`**. The layout
keeps us **trivially re-syncable** with a fast-moving upstream, the same way the
sibling `genezhang/pi` fork does.

## Governing principle: adapt via plugins, not core forks

OpenCode is extensible through a **plugin API** (`@opencode-ai/plugin`): tools,
hooks (`experimental.chat.system.transform`, `tool.execute.after`,
`experimental.session.compacting`, …), and commands loaded at runtime **without
modifying OpenCode's source**. Use that surface for customizations.

> We learned the hard way that *intrinsic* core changes (editing the engine
> itself) make catching up with upstream a constant, painful merge. The old
> `main` line did exactly that (+1100 lines across 14 core files) and fell
> thousands of commits behind upstream. The fix is to keep customizations **out
> of the fork**.

Concretely:
- The **zengram memory** integration lives in its own repo
  (`genezhang/zengram`, `integrations/opencode/`) as an OpenCode plugin, loaded
  at runtime. It causes **zero core divergence** — this fork only references it
  from `.opencode/opencode.jsonc`.
- Put a change on `work` **only if the plugin API genuinely cannot express it**
  (a missing hook, a core bug). Prefer upstreaming such changes as a PR to
  `sst/opencode`.

Success metric: `git diff upstream/dev...work` stays as small as possible
(today: the plugin config line + the zengram research docs under
`packages/opencode/specs/`).

## Branch layout

| Remote | Repo |
|---|---|
| `upstream` | `sst/opencode` (source of truth; **default branch is `dev`**) |
| `origin` | `genezhang/opencode` (this fork) |

| Branch | Role |
|---|---|
| `work` | Our integration branch — the GitHub **default**. Built on `upstream/dev`; holds only what can't be a plugin (the `.opencode/opencode.jsonc` plugin entry) plus research docs. |
| `main` | **FROZEN archive** of the old intrinsic integration + survey/benchmark history. **Do not commit here or rewrite it.** Pinned by the `main-intrinsic-archive` tag. Kept as the benchmark baseline until plugin parity is validated. |

The old intrinsic integration (embedded Zeta wired into `session/prompt.ts`,
`storage/`, `knowledge/`) is **superseded by the plugin** and intentionally not
carried onto `work`. Its full history remains on `main` / `zengram-v2`.

## Absorb upstream advances

```bash
git fetch upstream
git checkout work && git rebase upstream/dev
# resolve conflicts if any (rare while work stays small)
git push --force-with-lease origin work
```

## Check divergence from upstream (the "what did we change?" answer)

```bash
git fetch upstream
git log  upstream/dev..work     # exactly our commits on top of upstream
git diff upstream/dev...work    # exactly our net changes
```

## Running with the zengram plugin

The plugin is referenced from `.opencode/opencode.jsonc` as a `file:` path
resolved relative to that directory. It expects the `genezhang/zengram` checkout
as a sibling of this repo; see `../zengram/integrations/opencode/README.md` for
build/install. Use an absolute path in the config if your layout differs.
