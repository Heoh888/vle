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

## Install & run — step by step

### 1. Install the package(s)

```bash
# Next.js
npm install vle-editor

# Vite + React
npm install vle-editor vite-plugin-vle-editor
```

### 2. Scaffold the glue files

```bash
npx create-vle init
```

This detects your framework and writes only what it actually needs:

- **Next.js App Router** — `vle.config.ts`, thin `app/api/vle/*/route.ts` re-exports (Next.js resolves API routes from the file tree — there's no other way to define them), and a `components/ui-kit/index.ts` placeholder (see the gotcha below).
- **Vite + React** — just `vle.config.ts` and the placeholder. `vite-plugin-vle-editor` serves every endpoint itself from Vite's own dev server, no route files needed.

It also appends `.vle-worktrees/` to your `.gitignore`.

### 3. Wire the two manual pieces

These touch files that vary too much across real projects to safely edit automatically.

**Mount the overlay**, gated to development only (it writes to source files on disk — never let it run in production):

```tsx
// Next.js — app/layout.tsx (use the Next adapter, not the base export —
// it avoids a hydration flash by reading the URL in an SSR-safe way)
import { VisualEditorOverlay } from "vle-editor/overlay/adapters/next";
...
{process.env.NODE_ENV === "development" && <VisualEditorOverlay />}
```

```tsx
// Vite — src/main.tsx (the base export is correct here — Vite apps are
// pure client-rendered, no SSR hydration to worry about)
import { VisualEditorOverlay } from "vle-editor/overlay/VisualEditorOverlay";
...
{import.meta.env.DEV && <VisualEditorOverlay />}
```

**Wire the build-time instrumentation** that tags elements with `data-vle-id`:

```js
// Next.js — next.config.mjs
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

webpack(config, { dev }) {
  if (dev) {
    config.module.rules.unshift({
      test: /\.[jt]sx$/,
      exclude: [/node_modules/, /[\\/]app[\\/]api[\\/]/],
      enforce: "pre",
      use: [{ loader: require.resolve("vle-editor/babel-loader") }],
    });
  }
  // See "Gotchas" below — skip this if your project has no path alias.
  config.resolve.alias = { ...config.resolve.alias, "@": __dirname };
  return config;
},
```

```ts
// Vite — vite.config.ts
import vle from "vite-plugin-vle-editor";

export default defineConfig({
  plugins: [react(), vle()],
});
```

### 4. Run it

```bash
npm run dev
```

Open the app in a browser — the toolbar appears in the bottom-right corner. Click **🖊 Inspect** and hover an element to confirm it's wired up.

### Gotchas found the hard way

Both of these are handled automatically if you use `create-vle init` and the snippets above verbatim — listed here so you know *why*, and can diagnose a variant setup:

- **`Module not found: Can't resolve '@/components/ui-kit'` on Next.js.** The design-system palette's live previews use two dynamic imports keyed on `components/ui/${name}` and `components/ui-kit/${name}`. Webpack needs *some* file to exist at both paths at compile time — even before you've generated anything in `ui-kit`. `create-vle` scaffolds a placeholder `index.ts` there for exactly this reason.
- **Same error persists even with the placeholder in place.** Next.js's own tsconfig-paths integration doesn't reliably apply your project's path alias to *dynamic* imports originating from inside `node_modules`, even though normal static imports resolve fine. The explicit `config.resolve.alias` line above (native webpack aliasing, which Context Module resolution fully supports) fixes it. Skip this line entirely if your project doesn't use a path alias.

## Set up with an AI coding agent instead

If you'd rather have an agent (Claude Code, Cursor, etc.) do the whole install — including adapting the two manual steps to your project's actual structure, and setting up mock data/auth if your project needs a backend or auth provider that isn't running locally — paste this in:

```
You are setting up VLE (Visual Live Editor) in this project — an in-browser
click-to-edit tool for Next.js and Vite+React apps, with an optional
AI-agent-assisted editing mode. Follow these steps, adapting to what you
actually find in this repo rather than assuming a specific structure.

1. Detect the framework: look for app/layout.tsx or src/app/layout.tsx
   (Next.js App Router) vs a vite.config.* file (Vite + React). If neither
   exists, stop and tell me this project isn't currently supported — VLE
   requires one of these two.

2. Install the package(s):
   - Next.js: npm install vle-editor
   - Vite: npm install vle-editor vite-plugin-vle-editor

3. Run `npx create-vle init` from the project root. It writes vle.config.ts,
   a components/ui-kit/index.ts placeholder, and (Next.js only) the
   app/api/vle/*/route.ts files.

4. Wire the two pieces create-vle cannot safely automate — read its printed
   output for exact snippets, adapt paths to what you actually find:
   a. Mount <VisualEditorOverlay /> in the root layout/entry point, gated to
      development only.
      - Next.js: import from "vle-editor/overlay/adapters/next" (the
        SSR-safe adapter, not the base export).
      - Vite: import from "vle-editor/overlay/VisualEditorOverlay" (the base
        export is correct — Vite apps are pure client-rendered).
   b. Wire the build-time instrumentation:
      - Next.js (next.config.mjs): add the dev-only webpack rule for
        vle-editor/babel-loader, AND add an explicit config.resolve.alias
        entry for whatever path alias this project uses (commonly "@")
        pointing at the project root. Next's own tsconfig-paths integration
        does not reliably apply project aliases to *dynamic* imports from
        inside node_modules, which the design-system palette's live
        previews rely on. Skip this if the project has no path alias.
      - Vite: add vle() from vite-plugin-vle-editor to the plugins array.

5. Verify it actually works before reporting success — don't just claim it:
   - Start the dev server.
   - Confirm the toolbar appears in the bottom-right corner.
   - Click "Inspect" and confirm elements highlight on hover.
   - If anything 500s or shows "Module not found" mentioning
     components/ui-kit or a path alias, that's a known gotcha — see the
     VLE README's "Gotchas found the hard way" section, fix it before
     reporting success.

6. If this project is gated behind auth, and/or depends on backend services
   that aren't running locally right now — so a developer can't actually
   open the app and click around — set up a minimal, EXPLICIT opt-in mock:
   - Find the project's real auth setup (NextAuth, Clerk, a custom check,
     middleware, whatever it actually uses) and its data-fetching layer.
   - Add a bypass/mock path gated behind a clearly-named env var (e.g.
     MOCK_AUTH=1) that has to be set explicitly. Never bypass auth just
     because NODE_ENV=development — real auth might genuinely be available
     and working, don't silently override it.
   - Prefer going through the real auth library's own machinery (e.g. a
     NextAuth Credentials provider that always succeeds) over monkey-
     patching internals — this keeps every downstream session check and
     protected-route guard working completely unmodified.
   - For any page fetching data from a backend that isn't running, add mock
     API routes (or a mock fetcher) returning realistic data shaped to
     match the project's own existing TypeScript types — gated behind the
     same env flag, returning 404 when it's off, so this can never mask a
     real missing integration outside of explicit opt-in.
   - Document the flag with one line in .env.example.

7. Report back: what you installed, exactly how you adapted the manual
   wiring (and why, if you deviated from the snippets), and whether you set
   up any mocks — including the exact env var name to flip on.
```

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
