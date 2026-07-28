/**
 * Every VoxTap-specific assumption the original in-repo prototype baked in
 * (monorepo parent-dir layout, "frontend/services/workers" path anchors,
 * a hardcoded design-system folder, VoxTap's own project framing text)
 * lives here as an explicit, overridable field instead. A consuming
 * project's `vle.config.ts` builds one of these and passes it into every
 * exported function — nothing in this package reads `process.cwd()` or
 * assumes a repo layout on its own.
 */
export interface VleConfig {
  /** Absolute path to the Next.js app directory — where `app/`, `components/` live. */
  projectRoot: string;

  /**
   * Absolute path to the git repo root, if different from `projectRoot`
   * (e.g. a monorepo where the Next.js app lives in a `frontend/` subdir).
   * Worktrees are created here, so the agent sees the whole repo, not just
   * the app. Defaults to `projectRoot` — most consumers' Next.js app IS
   * their repo root.
   */
  repoRoot: string;

  /**
   * `projectRoot`'s path relative to `repoRoot` (e.g. `"frontend"`).
   * Needed to relocate the app directory inside a worktree of the whole
   * repo (preview-server spawning, `node_modules` symlinking). Empty
   * string when `projectRoot === repoRoot`.
   */
  appDir: string;

  /**
   * One-paragraph framing of the project handed to the agent before every
   * task — stack, structure, notable conventions. The more specific this
   * is, the less the agent has to rediscover by grepping around on every
   * single request.
   */
  promptContext: string;

  /** Directories (relative to `projectRoot`) scanned for the design-system palette. */
  uiDirs: string[];

  /**
   * Path segments used to shorten absolute file paths in the chat's live
   * step log (e.g. "Reading components/Header.tsx" instead of the full
   * worktree path). First match wins.
   */
  pathAnchors: string[];

  /** Accent color for the editor's own UI chrome (buttons, highlights, active states). */
  accentColor: string;

  /**
   * Whether the overlay's editing controls (corner radius, border,
   * padding/margin, colors, font size, alignment…) should write Tailwind
   * utility classes or real inline `style={{...}}` values. Found live,
   * the hard way: on a project with no Tailwind at all, a "corner radius"
   * edit wrote a syntactically valid `rounded-tl-[44px]` className — the
   * patch itself succeeded — but nothing rendered differently, because no
   * build step was ever generating CSS for that class. Inline styles are
   * a browser-level mechanism, not tied to any CSS methodology, so
   * `"inline"` is the one fallback that works regardless of what the
   * project actually uses for styling (CSS modules, styled-components,
   * plain CSS, antd, anything) — it just won't match an existing design
   * system's tokens the way a real Tailwind class would. Auto-detected
   * from whether a `tailwind.config.*` exists at `projectRoot` unless set
   * explicitly.
   */
  stylingMode: "tailwind" | "inline";

  /**
   * Directory (relative to `projectRoot`) where agent-generated creative
   * assets (images/video from whatever MCP-connected generation tools the
   * user has configured — Higgsfield, or anything else — VLE doesn't know
   * or care which) get saved, for review in the Creatives panel. Not part
   * of the git tree — `create-vle init` adds it to `.gitignore`.
   */
  creativesDir: string;

  /**
   * Directory (relative to `projectRoot`) that's served as static assets
   * at the site root — the "public" folder convention both Next.js and
   * Vite share. Used only when actually placing a creative onto the page
   * (dragged from the panel, or an agent wiring one in): the file gets
   * copied here from `creativesDir` first, so the reference in your JSX
   * (`/filename.png`) is a real, permanent asset — not a request to a
   * dev-only VLE endpoint that would 404 in production.
   */
  publicDir: string;

  /**
   * Absolute path to a *different* checkout of this same repo — the
   * "Promote to main repo" button's target. Only relevant for the
   * "Keeping VLE fully local" setup (see README): when VLE runs inside a
   * dedicated `local/*` branch's own git worktree, click-to-edit patches
   * land in that worktree's files, never in the developer's real
   * checkout. Setting this points VLE at that real checkout so a single
   * click can `git apply` the current diff over there. Left unset by
   * default — the Promote button doesn't render at all unless this is
   * explicitly configured, since it only makes sense in that specific
   * two-checkout setup.
   */
  mainRepoRoot?: string;
}

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_PROMPT_CONTEXT =
  "You are editing a Next.js/TypeScript project. You have full read/write access to this checkout — it's an isolated git worktree made specifically for this task.";

const DEFAULT_UI_DIRS = ["components/ui"];
const DEFAULT_ACCENT = "#9b8ec4";
const DEFAULT_CREATIVES_DIR = ".vle-creatives";
const DEFAULT_PUBLIC_DIR = "public";
const TAILWIND_CONFIG_CANDIDATES = ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs", "tailwind.config.cjs"];

function detectStylingMode(projectRoot: string): "tailwind" | "inline" {
  const hasTailwindConfig = TAILWIND_CONFIG_CANDIDATES.some((f) => fs.existsSync(path.join(projectRoot, f)));
  return hasTailwindConfig ? "tailwind" : "inline";
}

/**
 * Found live, the hard way: defaulting repoRoot to projectRoot (the old
 * behavior) is wrong for any project that's actually a subdirectory of a
 * larger monorepo — git itself searches upward for the real .git root
 * regardless of what `cwd` a command runs from, so worktree *creation*
 * still silently succeeded against the real repo, but the worktree's
 * physical *path* was computed from the wrong (too-narrow) root and ended
 * up nested inside projectRoot — i.e. inside the exact directory a dev
 * server's file watcher watches. A ~1000-file burst appearing there
 * (a full monorepo checkout, including a fresh nested copy of the
 * project's own vite.config.ts) is what triggered an unexpected full
 * page reload the moment an agent job started. Walking up to the real
 * git top-level up front avoids ever computing a worktree path inside a
 * watched directory in the first place.
 */
function detectRepoRoot(projectRoot: string): string {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: projectRoot, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
    return out || projectRoot;
  } catch {
    return projectRoot; // not a git repo (yet) — fall back to the old default rather than fail config resolution over it
  }
}

export type VleConfigInput = Partial<VleConfig> & { projectRoot: string };

/** Fills in every field a consumer's `vle.config.ts` didn't set. Only `projectRoot` is required. */
export function resolveConfig(input: VleConfigInput): VleConfig {
  const projectRoot = input.projectRoot;
  const repoRoot = input.repoRoot ?? detectRepoRoot(projectRoot);
  return {
    projectRoot,
    repoRoot,
    appDir: input.appDir ?? (repoRoot === projectRoot ? "" : path.relative(repoRoot, projectRoot).split(path.sep).join("/")),
    promptContext: input.promptContext ?? DEFAULT_PROMPT_CONTEXT,
    uiDirs: input.uiDirs ?? DEFAULT_UI_DIRS,
    pathAnchors: input.pathAnchors ?? [],
    accentColor: input.accentColor ?? DEFAULT_ACCENT,
    stylingMode: input.stylingMode ?? detectStylingMode(projectRoot),
    creativesDir: input.creativesDir ?? DEFAULT_CREATIVES_DIR,
    publicDir: input.publicDir ?? DEFAULT_PUBLIC_DIR,
    mainRepoRoot: input.mainRepoRoot,
  };
}
