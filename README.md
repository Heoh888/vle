# VLE — Visual Live Editor

Click an element in your running Next.js app, edit it visually, and watch the change land in your actual source code — no separate design tool, no synced-but-different "design system," no third-party service touching your code. Everything runs locally, dev-only, against your own repo.

VLE also wires in a headless [Claude Code](https://claude.com/claude-code) agent for the edits that aren't just "change this padding" — leave a comment on an element, or open the chat, and describe what you want. The agent works in an **isolated git worktree**, and nothing touches your real files until you review the diff and click **Apply**.

## Why

Most visual editors for React either lock you into their own hosted format, or bolt AI edits directly onto your working tree with no review step. VLE does neither:

- **Your code stays your code.** Edits are precise source-text splices (via Babel), not a regenerated file or a parallel "design" representation that has to be kept in sync.
- **Agent changes are never live until you say so.** Every agent run — a one-off comment or a full chat conversation — happens in its own git worktree on its own branch. You get a diff. You click Apply or Discard. There is no third state.
- **Nothing ships to production.** The whole tool (overlay UI, API routes, the webpack instrumentation that tags elements) is gated to `NODE_ENV=development` and refuses non-localhost requests.

## Features

- **Inspect & edit** — click any element, adjust spacing, colors, typography, borders, corner radius, fills/gradients, through a real property panel.
- **Resize & reorder** — drag handles, or drag-reorder siblings directly in the page.
- **Responsive preview** — check how the page looks at common device sizes without leaving the browser.
- **Comment → agent** — leave a note on an element ("make this collapse on mobile"); an isolated Claude Code agent makes the change and hands back a diff.
- **Global chat** — a persistent conversation with the same agent, not tied to one element; ask questions or request broader changes.
- **Design-system palette** — auto-discovered from `components/ui/`, with live (not mocked) previews you can drag onto the page.
- **Generate a design system** — no design system yet? The agent can study your app's actual colors, spacing, and typography and generate one, in its own reviewable diff.
- **Undo/redo**, all edits included.

## Quickstart

```bash
cd your-nextjs-app
npx create-vle init
```

This writes the files Next.js requires to physically exist in your project (API routes, `vle.config.ts`) and prints the two remaining manual steps: mounting `<VisualEditorOverlay />` in your layout, and wiring the dev-only webpack loader. See the printed output for exact snippets.

> **Status:** not yet published to the npm registry. Until then, point your `package.json` at this checkout directly (`"vle": "file:../path/to/vle/packages/core"`) or build a tarball with `npm pack`.

Once running, open your app in dev mode and look for the toolbar in the bottom-right corner.

## Configuration

`vle.config.ts`, generated at your project root:

```ts
import { resolveConfig } from "vle/config";

export const vleConfig = resolveConfig({
  projectRoot: process.cwd(),
  // repoRoot: path.resolve(process.cwd(), ".."),   // monorepo: app lives in a subdir
  // promptContext: "You are editing my-app, a Next.js app using Tailwind + shadcn/ui...",
  // uiDirs: ["components/ui"],
  // accentColor: "#9b8ec4",
});
```

Only `projectRoot` is required. See `packages/core/src/config.ts` for what each field does.

## Safety model

The agent features (comment-to-agent, chat, design-system generation) run `claude` with `--dangerously-skip-permissions`. That's a real capability, not a toy — mitigated by three things working together, not any one of them alone:

1. **Isolated worktree.** Every agent run gets its own `git worktree` on its own throwaway branch under `.vle-worktrees/`. It never runs directly against your working tree.
2. **Diff review.** When a run finishes (or fails partway — partial progress is never silently discarded), you see the full diff before anything happens to your real files.
3. **Explicit Apply.** Nothing lands until you click it. Discard removes the worktree and branch entirely.

This only runs in development, only accepts requests from localhost, and is meant to be used the same way you'd use any local dev tool — not exposed on a network, not run against a repo you don't control.

## Project structure

```
packages/
  core/         the "vle" package — patch engine, agent/chat runners, design-system scanner, overlay UI
  create-vle/   the npx scaffolder — writes the Next.js–specific glue into your project
```

## License

MIT
