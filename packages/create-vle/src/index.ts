#!/usr/bin/env node
/**
 * `npx create-vle init` — lays down the handful of files that physically
 * have to exist inside a consuming project's own file tree, because the
 * bundler/router resolves them from there — there's no way to ship those
 * as pure npm-importable code. Everything else (the actual logic, the
 * overlay UI) ships as normal npm dependencies (`vle-editor`, and for Vite
 * projects `vite-plugin-vle-editor`). Same shape as shadcn/ui's `init` for the
 * same class of problem.
 *
 * Supports two frameworks, auto-detected:
 *  - Next.js App Router: thin app/api/vle/*\/route.ts re-exports (Next
 *    resolves API routes from the file tree, no other way to define them).
 *  - Vite + React: no route files needed at all — vite-plugin-vle-editor serves
 *    the same endpoints itself via Vite's own dev server middleware.
 *
 * Deliberately does not touch layout.tsx/main.tsx or next.config.mjs/
 * vite.config.ts automatically — both vary too much across real projects
 * to safely string-patch. Prints exact snippets instead and lets the
 * developer place them.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";

const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

type Framework = "next" | "vite";

function readPackageJson(cwd: string): any | null {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
}

function findNextAppDir(cwd: string): string | null {
  for (const candidate of ["app", "src/app"]) {
    if (fs.existsSync(path.join(cwd, candidate, "layout.tsx")) || fs.existsSync(path.join(cwd, candidate, "layout.jsx"))) {
      return candidate;
    }
  }
  return null;
}

function findViteConfig(cwd: string): string | null {
  for (const candidate of ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"]) {
    if (fs.existsSync(path.join(cwd, candidate))) return candidate;
  }
  return null;
}

function detectFramework(cwd: string, pkg: any): { framework: Framework; appDir?: string; viteConfigFile?: string } | null {
  const appDir = findNextAppDir(cwd);
  if (appDir) return { framework: "next", appDir };

  const viteConfigFile = findViteConfig(cwd);
  if (viteConfigFile) return { framework: "vite", viteConfigFile };

  return null;
}

function copyRouteTemplates(srcDir: string, destBase: string): { written: string[]; skipped: string[] } {
  const written: string[] = [];
  const skipped: string[] = [];

  function walk(dir: string, relPrefix: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, path.join(relPrefix, entry.name));
        continue;
      }
      if (!entry.name.endsWith(".tmpl")) continue;
      const destRel = path.join(relPrefix, entry.name.replace(/\.tmpl$/, ""));
      const destAbs = path.join(destBase, destRel);
      if (fs.existsSync(destAbs)) {
        skipped.push(destRel);
        continue;
      }
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.copyFileSync(abs, destAbs);
      written.push(destRel);
    }
  }

  walk(srcDir, "");
  return { written, skipped };
}

function ensureGitignoreEntry(cwd: string): void {
  const gitignorePath = path.join(cwd, ".gitignore");
  let contents = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";

  const entries = [".vle-worktrees/", ".vle-creatives/", ".vle-chats/"];
  for (const entry of entries) {
    if (contents.includes(entry.replace(/\/$/, ""))) continue;
    const sep = contents.endsWith("\n") || contents === "" ? "" : "\n";
    contents += `${sep}${entry}\n`;
    console.log(`  + appended ${entry} to .gitignore`);
  }

  fs.writeFileSync(gitignorePath, contents, "utf8");
}

function writeVleConfig(cwd: string): void {
  const configDest = path.join(cwd, "vle.config.ts");
  if (fs.existsSync(configDest)) {
    console.log("  · vle.config.ts already exists, skipping");
    return;
  }
  fs.copyFileSync(path.join(TEMPLATES_DIR, "vle.config.ts.tmpl"), configDest);
  console.log("  + vle.config.ts");
}

/**
 * The design-system palette's "Generate design system" flow writes agent
 * output into components/ui-kit/ — a folder that doesn't exist yet on a
 * fresh project (nothing's been generated there). Found live: the overlay
 * statically imports DesignSystemPanel, whose two dynamic imports
 * (components/ui/${name}, components/ui-kit/${name}) both get analyzed by
 * webpack the moment the app boots in dev, not lazily when the panel
 * opens — webpack's context-module resolution needs *some* file to exist
 * at that path to build a valid context, even for a branch never reached
 * at runtime. Without this, every fresh Next.js project 500s on its very
 * first dev-server request, before anyone's touched the design-system
 * feature at all.
 */
function ensureUiKitPlaceholder(cwd: string): void {
  const dir = path.join(cwd, "components", "ui-kit");
  const indexPath = path.join(dir, "index.ts");
  if (fs.existsSync(indexPath)) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(indexPath, "export {};\n", "utf8");
  console.log("  + components/ui-kit/index.ts (placeholder — the design-system palette writes here once you generate one)");
}

/**
 * Nudge, not a gate — on a shared repo, everything this command just wrote
 * (vle.config.ts, app/api/vle/*, plus the two manual edits still to come)
 * sits as tracked changes or new files nobody else asked for. Cheapest
 * signal for "you're probably not already isolated": the current branch
 * doesn't look like a dedicated local-only one. Doesn't block anything —
 * just points at the README section for anyone who hasn't seen it yet.
 */
function printLocalBranchTip(cwd: string): void {
  let branch = "";
  try {
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
  } catch {
    return; // not a git repo (yet) — nothing useful to say
  }
  if (branch.startsWith("local/")) return;
  console.log(
    `Tip: if this repo is shared with people who don't use VLE, consider running\n` +
      `this inside a dedicated local-only branch/worktree instead — see the README's\n` +
      `"Keeping VLE fully local" section. Nothing above changes, just *where* you run it.\n`
  );
}

function initNext(cwd: string, appDir: string): void {
  console.log(`Found Next.js App Router project (${appDir}/).\n`);

  writeVleConfig(cwd);

  const apiDest = path.join(cwd, appDir, "api", "vle");
  const { written, skipped } = copyRouteTemplates(path.join(TEMPLATES_DIR, "api-routes"), apiDest);
  for (const f of written) console.log(`  + ${appDir}/api/vle/${f}`);
  for (const f of skipped) console.log(`  · ${appDir}/api/vle/${f} already exists, skipping`);

  ensureUiKitPlaceholder(cwd);
  ensureGitignoreEntry(cwd);

  console.log(`
Three manual steps left — these touch files that vary too much across
projects to safely edit automatically:

1. Install the package:
     npm install vle-editor

2. Mount the overlay in ${appDir}/layout.tsx, gated to development only
   (it writes to source files on disk — never let it run in production).
   Use the Next.js adapter, not the base export — it keeps the toolbar
   from flashing visible for a frame during server-side rendering. Also
   exclude VLE_PREVIEW — it's set only on the throwaway \`next dev\` the
   comment-to-agent flow's own Preview button spawns to show the agent's
   diff in an iframe; that instance must not mount its own nested overlay:

     import { VisualEditorOverlay } from "vle-editor/overlay/adapters/next";
     ...
     {process.env.NODE_ENV === "development" && !process.env.VLE_PREVIEW && <VisualEditorOverlay />}

3. Wire the dev-only babel loader into next.config.mjs so elements get
   tagged with data-vle-id/data-vle-loc. next.config.mjs is an ES module —
   plain \`require\` isn't defined there, so build one via createRequire.
   Also add an explicit webpack resolve.alias for "@" — found live: Next's
   own tsconfig-paths integration doesn't reliably apply your project's
   "@/*" alias to *dynamic* imports (the design-system palette's live
   previews use one) when the importing code lives inside node_modules,
   even though normal static imports resolve fine. A native webpack alias
   doesn't have that gap. Skip this if your project doesn't use an "@/*"
   alias, or adjust "@" to whatever alias you actually use:

     import { createRequire } from "node:module";
     import path from "node:path";
     import { fileURLToPath } from "node:url";
     const require = createRequire(import.meta.url);
     const __dirname = path.dirname(fileURLToPath(import.meta.url));

     webpack(config, { dev }) {
       if (dev) {
         config.module.rules.unshift({
           test: /\\.[jt]sx$/,
           exclude: [/node_modules/, /[\\\\/]app[\\\\/]api[\\\\/]/],
           enforce: "pre",
           use: [{ loader: require.resolve("vle-editor/babel-loader") }],
         });
       }
       config.resolve.alias = { ...config.resolve.alias, "@": __dirname };
       return config;
     }

Then run \`npm run dev\`, open the app, and look for the toolbar in the
bottom-right corner.

One more thing worth knowing before you turn on the agent/chat features:
they shell out to the Claude Code CLI with --dangerously-skip-permissions
inside an isolated git worktree, and nothing touches your real files until
you review the diff and click Apply. Make sure the \`claude\` CLI is
installed and logged in first.
`);
  printLocalBranchTip(cwd);
}

function findViteEntry(cwd: string): string | null {
  for (const candidate of ["src/main.tsx", "src/App.tsx", "main.tsx", "App.tsx"]) {
    if (fs.existsSync(path.join(cwd, candidate))) return candidate;
  }
  return null;
}

function initVite(cwd: string, viteConfigFile: string): void {
  console.log(`Found a Vite project (${viteConfigFile}).\n`);

  writeVleConfig(cwd);
  ensureUiKitPlaceholder(cwd);
  ensureGitignoreEntry(cwd);

  const entry = findViteEntry(cwd);
  const entryHint = entry ? entry : "your app's root component";

  console.log(`
No route files needed for Vite — vite-plugin-vle-editor serves the /api/vle/*
endpoints itself from Vite's own dev server. Two manual steps left:

1. Install the packages:
     npm install vle-editor vite-plugin-vle-editor

2. Add the plugin to ${viteConfigFile}:

     import vle from "vite-plugin-vle-editor";

     export default defineConfig({
       plugins: [react(), vle()],
     });

3. Mount the overlay in ${entryHint}, gated to development only (it writes
   to source files on disk — never let it run in production). Vite/CRA-style
   apps are pure client-rendered, so the base export (no adapter needed)
   is exactly right here:

     import { VisualEditorOverlay } from "vle-editor/overlay/VisualEditorOverlay";
     ...
     {import.meta.env.DEV && <VisualEditorOverlay />}

Then run \`npm run dev\`, open the app, and look for the toolbar in the
bottom-right corner.

One more thing worth knowing before you turn on the agent/chat features:
they shell out to the Claude Code CLI with --dangerously-skip-permissions
inside an isolated git worktree, and nothing touches your real files until
you review the diff and click Apply. Make sure the \`claude\` CLI is
installed and logged in first.
`);
  printLocalBranchTip(cwd);
}

function init(): void {
  const cwd = process.cwd();
  const pkg = readPackageJson(cwd);

  if (!pkg) {
    console.error("No package.json found here — run this from the root of your project.");
    process.exit(1);
  }

  const detected = detectFramework(cwd, pkg);
  if (!detected) {
    console.error(
      "Couldn't detect a supported framework here. VLE currently supports:\n" +
        "  - Next.js App Router (looks for app/layout.tsx or src/app/layout.tsx)\n" +
        "  - Vite + React (looks for vite.config.{ts,js,mjs,cjs})"
    );
    process.exit(1);
  }

  if (detected.framework === "next") {
    initNext(cwd, detected.appDir!);
  } else {
    initVite(cwd, detected.viteConfigFile!);
  }
}

function askConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

/**
 * `npx create-vle teardown` — the other half of the "Keeping VLE fully
 * local" setup (see README): removes the dedicated local/* branch's git
 * worktree and the branch itself. Deliberately a standalone terminal
 * command, not a button in VLE's own UI — the dev server answering that
 * button click would be running *from inside* the very directory being
 * deleted, which doesn't have a clean way to both finish removing itself
 * and report success back to the browser. Run this after stopping
 * `npm run dev`, from inside the worktree you want gone.
 *
 * Two safety checks before touching anything, both hard failures (not
 * warnings): this must be a *linked* worktree (its `.git` is a file
 * pointing at the real repo, not a real `.git` directory — a plain
 * checkout's `.git` is always a directory, so this alone rules out ever
 * running against someone's only copy of a repo), and its checked-out
 * branch must match the `local/*` naming convention this whole setup
 * relies on — refusing anything else means teardown can never delete a
 * worktree/branch it didn't create this way, even if pointed at one.
 */
async function teardown(): Promise<void> {
  const cwd = process.cwd();

  let worktreeRoot: string;
  try {
    worktreeRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
  } catch {
    console.error("Not inside a git repo.");
    process.exit(1);
  }

  const gitPath = path.join(worktreeRoot, ".git");
  let gitStat: fs.Stats;
  try {
    gitStat = fs.lstatSync(gitPath);
  } catch {
    console.error(`No .git found at ${worktreeRoot} — nothing to tear down.`);
    process.exit(1);
  }
  if (!gitStat.isFile()) {
    console.error(
      `${worktreeRoot}'s .git is a real directory, not a linked worktree's .git file — this looks\n` +
        `like a normal checkout. Refusing to touch it: teardown only ever removes a *linked*\n` +
        `worktree created via "git worktree add", never a repo's main checkout.`
    );
    process.exit(1);
  }

  let branch: string;
  try {
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreeRoot, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
  } catch {
    console.error("Couldn't determine the current branch.");
    process.exit(1);
  }
  if (!branch.startsWith("local/")) {
    console.error(
      `Current branch is "${branch}", not under local/* — refusing to delete it.\n` +
        `teardown only ever removes branches following the "Keeping VLE fully local" naming\n` +
        `convention (see the README), so it can never delete something else by mistake.`
    );
    process.exit(1);
  }

  // A linked worktree's .git file reads "gitdir: /main/repo/.git/worktrees/<name>".
  const gitFileContents = fs.readFileSync(gitPath, "utf8").trim();
  const match = gitFileContents.match(/^gitdir:\s*(.+)$/);
  if (!match) {
    console.error(`Couldn't parse ${gitPath} (unexpected format) — aborting rather than guess.`);
    process.exit(1);
  }
  const mainRepoRoot = path.dirname(path.dirname(path.dirname(match[1])));

  console.log(
    `This will permanently remove:\n` +
      `  worktree: ${worktreeRoot}\n` +
      `  branch:   ${branch}\n` +
      `(git commands run from: ${mainRepoRoot})\n\n` +
      `Make sure \`npm run dev\` isn't still running from inside that worktree before continuing.\n`
  );
  const confirmed = await askConfirm('Type "yes" to continue: ');
  if (!confirmed) {
    console.log("Aborted — nothing was touched.");
    return;
  }

  try {
    execFileSync("git", ["worktree", "remove", worktreeRoot, "--force"], { cwd: mainRepoRoot, stdio: "pipe" });
  } catch {
    // Same fallback as agentRunner.ts's cleanupWorktree — found live: a
    // process still holding the worktree as its cwd at the exact moment
    // of removal can leave a half-deleted worktree (.git gone, rest of
    // the tree still there) that plain --force refuses to finish.
    try {
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: mainRepoRoot, stdio: "pipe" });
    } catch {
      // Best-effort.
    }
  }

  try {
    execFileSync("git", ["branch", "-D", branch], { cwd: mainRepoRoot, stdio: "pipe" });
  } catch (err) {
    console.error(`Worktree removed, but failed to delete branch "${branch}": ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(`Done — removed the worktree and deleted branch "${branch}".`);
}

const [, , command] = process.argv;
if (command === "init") {
  init();
} else if (command === "teardown") {
  teardown().catch((err) => {
    console.error(`teardown failed: ${(err as Error).message}`);
    process.exit(1);
  });
} else {
  console.log("Usage: npx create-vle init\n       npx create-vle teardown");
  process.exit(command ? 1 : 0);
}
