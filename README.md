# VLE — Visual Live Editor

Click an element in your running app, edit it visually, and watch the change land in your actual source code — no separate design tool, no synced-but-different "design system," no third-party service touching your code. Everything runs locally, dev-only, against your own repo. Works with **Next.js (App Router)** and **Vite + React**.

VLE also wires in a headless [Claude Code](https://claude.com/claude-code) agent for the edits that aren't just "change this padding" — leave a comment on an element, or open the chat, and describe what you want. The agent works in an **isolated git worktree**, and nothing touches your real files until you review the diff and click **Apply**.

## Why

Most visual editors for React either lock you into their own hosted format, or bolt AI edits directly onto your working tree with no review step. VLE does neither:

- **Your code stays your code.** Edits are precise source-text splices (via Babel), not a regenerated file or a parallel "design" representation that has to be kept in sync.
- **Agent changes are never live until you say so.** Every agent run — a one-off comment or a full chat conversation — happens in its own git worktree on its own branch. You get a diff. You click Apply or Discard. There is no third state.
- **Nothing ships to production.** The whole tool (overlay UI, dev-server endpoints, the build-time instrumentation that tags elements) is gated to `NODE_ENV=development` and refuses non-localhost requests.

## Features

- **Inspect & edit** — click any element, adjust spacing, colors, typography, borders, corner radius, fills/gradients, through a real property panel. Falls back to real inline styles automatically on projects with no Tailwind, so it works regardless of what you style with.
- **Resize & reorder** — drag handles, or drag-reorder siblings directly in the page.
- **Responsive preview** — check how the page looks at common device sizes without leaving the browser.
- **Comment → agent** — leave a note on an element ("make this collapse on mobile"); an isolated Claude Code agent makes the change and hands back a diff.
- **Global chat** — a persistent conversation with the same agent, not tied to one element; ask questions or request broader changes.
- **Design-system palette** — auto-discovered from `components/ui/`, with live (not mocked) previews you can drag onto the page.
- **Generate a design system** — no design system yet? The agent can study your app's actual colors, spacing, and typography and generate one, in its own reviewable diff.
- **Undo/redo**, all edits included.

## Quickstart

```bash
cd your-app
npx create-vle init
```

`create-vle` detects your framework and writes only what that framework actually requires:

- **Next.js App Router** — thin `app/api/vle/*/route.ts` re-exports and `vle.config.ts` (Next.js resolves API routes from the file tree — there's no other way to define them).
- **Vite + React** — just `vle.config.ts`. `vite-plugin-vle-editor` serves every endpoint itself from Vite's own dev server, no route files needed.

Either way, it prints the couple of manual steps left (mounting the overlay, wiring the framework's build hook) with exact snippets for your setup.

Once running, open your app in dev mode and look for the toolbar in the bottom-right corner.

## Configuration

`vle.config.ts`, generated at your project root:

```ts
import { resolveConfig } from "vle-editor/config";

export const vleConfig = resolveConfig({
  projectRoot: process.cwd(),
  // repoRoot: path.resolve(process.cwd(), ".."),   // only needed to override auto-detection — see below
  // promptContext: "You are editing my-app, a Next.js app using Tailwind + shadcn/ui...",
  // uiDirs: ["components/ui"],
  // accentColor: "#9b8ec4",
  // stylingMode: "inline",   // only needed to override auto-detection — see below
});
```

Only `projectRoot` is required. Two fields are auto-detected rather than defaulted, because guessing wrong here caused real bugs during development:

- **`repoRoot`** — resolved via `git rev-parse --show-toplevel`, not assumed to equal `projectRoot`. If your app is a subdirectory of a larger monorepo, this matters: agent worktrees are created at `repoRoot`, and a worktree that lands inside a directory your dev server watches (because `repoRoot` was wrongly assumed to be `projectRoot`) can trigger a full page reload the moment an agent job starts — found live, the hard way.
- **`stylingMode`** — `"tailwind"` if a `tailwind.config.*` exists at `projectRoot`, otherwise `"inline"`. On a project with no Tailwind, edits fall back to real `style={{...}}` values instead of utility classes that no build step would ever turn into CSS.

See `packages/core/src/config.ts` for what every field does.

## Safety model

The agent features (comment-to-agent, chat, design-system generation) run `claude` with `--dangerously-skip-permissions`. That's a real capability, not a toy — mitigated by three things working together, not any one of them alone:

1. **Isolated worktree.** Every agent run gets its own `git worktree` on its own throwaway branch under `.vle-worktrees/`. It never runs directly against your working tree.
2. **Diff review.** When a run finishes (or fails partway — partial progress is never silently discarded), you see the full diff before anything happens to your real files.
3. **Explicit Apply.** Nothing lands until you click it. Discard removes the worktree and branch entirely.

This only runs in development, only accepts requests from localhost, and is meant to be used the same way you'd use any local dev tool — not exposed on a network, not run against a repo you don't control.

## Project structure

```
packages/
  core/          the "vle-editor" package — patch engine, agent/chat runners, design-system scanner, overlay UI
  vite-plugin/   "vite-plugin-vle-editor" — Vite adapter: build-time instrumentation + serves the dev endpoints itself
  create-vle/    the npx scaffolder — writes the framework-specific glue into your project
```

## License

MIT
