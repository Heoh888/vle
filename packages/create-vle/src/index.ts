#!/usr/bin/env node
/**
 * `npx create-vle init` — lays down the handful of files that physically
 * have to exist inside a consuming Next.js App Router project (thin
 * app/api/vle/*\/route.ts re-exports, a vle.config.ts) because Next.js
 * resolves API routes and webpack config from the project's own file tree —
 * there's no way to ship those as pure npm-importable code. Everything else
 * (the actual logic, the overlay UI) ships as the normal `vle` npm
 * dependency. Same shape as shadcn/ui's `init` for the same class of
 * problem.
 *
 * Deliberately does not touch layout.tsx or next.config.mjs automatically
 * — both vary too much across real projects to safely string-patch. Prints
 * exact snippets instead and lets the developer place them.
 */
import fs from "node:fs";
import path from "node:path";

const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

function findAppDir(cwd: string): string | null {
  for (const candidate of ["app", "src/app"]) {
    if (fs.existsSync(path.join(cwd, candidate, "layout.tsx")) || fs.existsSync(path.join(cwd, candidate, "layout.jsx"))) {
      return candidate;
    }
  }
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
  if (!fs.existsSync(gitignorePath)) return;
  const contents = fs.readFileSync(gitignorePath, "utf8");
  if (contents.includes(".vle-worktrees")) return;
  const sep = contents.endsWith("\n") || contents === "" ? "" : "\n";
  fs.writeFileSync(gitignorePath, `${contents}${sep}.vle-worktrees/\n`, "utf8");
  console.log("  + appended .vle-worktrees/ to .gitignore");
}

function init(): void {
  const cwd = process.cwd();

  if (!fs.existsSync(path.join(cwd, "package.json"))) {
    console.error("No package.json found here — run this from the root of your Next.js project.");
    process.exit(1);
  }

  const appDir = findAppDir(cwd);
  if (!appDir) {
    console.error("Couldn't find app/layout.tsx or src/app/layout.tsx — VLE only supports the Next.js App Router.");
    process.exit(1);
  }

  console.log(`Found Next.js App Router project (${appDir}/).\n`);

  // vle.config.ts
  const configDest = path.join(cwd, "vle.config.ts");
  if (fs.existsSync(configDest)) {
    console.log("  · vle.config.ts already exists, skipping");
  } else {
    fs.copyFileSync(path.join(TEMPLATES_DIR, "vle.config.ts.tmpl"), configDest);
    console.log("  + vle.config.ts");
  }

  // app/api/vle/**/route.ts
  const apiDest = path.join(cwd, appDir, "api", "vle");
  const { written, skipped } = copyRouteTemplates(path.join(TEMPLATES_DIR, "api-routes"), apiDest);
  for (const f of written) console.log(`  + ${appDir}/api/vle/${f}`);
  for (const f of skipped) console.log(`  · ${appDir}/api/vle/${f} already exists, skipping`);

  ensureGitignoreEntry(cwd);

  console.log(`
Three manual steps left — these touch files that vary too much across
projects to safely edit automatically:

1. Install the package (not yet on the npm registry — for now, point at
   this checkout or a tarball):
     npm install vle

2. Mount the overlay in ${appDir}/layout.tsx, gated to development only
   (it writes to source files on disk — never let it run in production):

     import { VisualEditorOverlay } from "vle/overlay/VisualEditorOverlay";
     ...
     {process.env.NODE_ENV === "development" && <VisualEditorOverlay />}

3. Wire the dev-only babel loader into next.config.mjs so elements get
   tagged with data-vle-id/data-vle-loc:

     import path from "node:path";

     webpack(config, { dev }) {
       if (dev) {
         config.module.rules.unshift({
           test: /\\.[jt]sx$/,
           exclude: [/node_modules/, /[\\\\/]app[\\\\/]api[\\\\/]/],
           enforce: "pre",
           use: [{ loader: require.resolve("vle/babel-loader") }],
         });
       }
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
}

const [, , command] = process.argv;
if (command === "init") {
  init();
} else {
  console.log("Usage: npx create-vle init");
  process.exit(command ? 1 : 0);
}
