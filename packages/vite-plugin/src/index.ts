/**
 * Vite adapter for VLE — the counterpart to Next.js's webpack loader +
 * app/api/vle/*\/route.ts files. Vite doesn't have a built-in routing
 * layer the way Next.js's App Router does, so instead of scaffolding N
 * separate route files, this plugin does both jobs itself:
 *
 *  - `transform`: same JSX instrumentation as the webpack loader (shared
 *    via vle-editor/instrumentJsx, not duplicated), applied to every .tsx/.jsx
 *    file Vite's dev server serves.
 *  - `configureServer`: registers one middleware on Vite's own dev server
 *    (Vite's dev server is Express/Connect-compatible under the hood, this
 *    is a documented, stable extension point — no second process/port
 *    needed) that serves every /api/vle/* endpoint by calling the exact
 *    same core functions the Next.js route templates call.
 *
 * Both dev-only: `apply: "serve"` means this plugin (and everything it
 * wires up) never runs during `vite build` — the same "never ships to
 * production" guarantee the Next.js integration has via `dev` in
 * next.config.mjs's webpack() and NODE_ENV in devGate.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import fs from "node:fs";
import type { Plugin } from "vite";
import { instrumentJsx } from "vle-editor/instrumentJsx";
import { checkDevGate } from "vle-editor/devGateCore";
import { resolveConfig, type VleConfig, type VleConfigInput } from "vle-editor/config";
import { startAgentJob, getJobStatus, refineJob, startPreview, applyJob, discardJob } from "vle-editor/agentRunner";
import { startChatSession, getChatStatus, sendChatMessage, applyChatSession, discardChatSession, listChatSessions } from "vle-editor/chatRunner";
import { applyPatch, resolveProjectFile, type PatchRequest } from "vle-editor/patch";
import { pushHistory, historyStatus, undo, redo } from "vle-editor/history";
import { scanDesignSystem } from "vle-editor/designSystemScan";
import { scanCreatives, resolveCreativeFile, copyCreativeToPublic } from "vle-editor/creativesScan";

export type VlePluginOptions = Partial<Omit<VleConfigInput, "projectRoot">> & { projectRoot?: string };

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function sendBinary(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function handleApi(req: IncomingMessage, res: ServerResponse, config: VleConfig): Promise<void> {
  const gate = checkDevGate((req.headers.host as string) ?? null);
  if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });

  const url = req.url ?? "";
  const [pathname, search] = url.split("?");
  const params = new URLSearchParams(search ?? "");
  const method = req.method ?? "GET";

  // GET endpoints
  if (method === "GET" && pathname === "/api/vle/agent") {
    const jobId = params.get("jobId");
    if (!jobId) return sendJson(res, 400, { ok: false, reason: "missing jobId" });
    const job = getJobStatus(jobId);
    if (!job) return sendJson(res, 404, { ok: false, reason: "job not found" });
    return sendJson(res, 200, { ok: true, job });
  }
  if (method === "GET" && pathname === "/api/vle/chat") {
    const chatId = params.get("chatId");
    if (!chatId) return sendJson(res, 400, { ok: false, reason: "missing chatId" });
    const chat = getChatStatus(chatId, config.repoRoot);
    if (!chat) return sendJson(res, 404, { ok: false, reason: "chat session not found" });
    return sendJson(res, 200, { ok: true, chat });
  }
  if (method === "GET" && pathname === "/api/vle/chat/list") {
    return sendJson(res, 200, { ok: true, chats: listChatSessions(config.repoRoot) });
  }
  if (method === "GET" && pathname === "/api/vle/design-system") {
    const components = scanDesignSystem(config);
    return sendJson(res, 200, { ok: true, components });
  }
  if (method === "GET" && pathname === "/api/vle/meta") {
    return sendJson(res, 200, { ok: true, stylingMode: config.stylingMode });
  }
  if (method === "GET" && pathname === "/api/vle/creatives") {
    return sendJson(res, 200, { ok: true, assets: scanCreatives(config) });
  }
  if (method === "GET" && pathname === "/api/vle/creatives/file") {
    const name = params.get("name");
    if (!name) return sendJson(res, 400, { ok: false, reason: "missing name" });
    const resolved = resolveCreativeFile(config, name);
    if (!resolved) return sendJson(res, 404, { ok: false, reason: "not found" });
    return sendBinary(res, 200, fs.readFileSync(resolved.absPath), resolved.mimeType);
  }

  // POST endpoints
  if (method !== "POST") return sendJson(res, 404, { ok: false, reason: "not found" });

  let body: any;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, reason: "invalid JSON body" });
  }

  if (pathname === "/api/vle/agent") {
    if (!body?.file || !body?.vleId || !body?.prompt || !String(body.prompt).trim()) {
      return sendJson(res, 400, { ok: false, reason: "missing file/vleId/prompt" });
    }
    const result = startAgentJob(config, { file: body.file, vleId: body.vleId, prompt: body.prompt });
    return sendJson(res, result.ok ? 200 : 422, result);
  }
  if (pathname === "/api/vle/agent/apply") {
    if (!body?.jobId) return sendJson(res, 400, { ok: false, reason: "missing jobId" });
    const result = applyJob(body.jobId);
    return sendJson(res, result.ok ? 200 : 422, result);
  }
  if (pathname === "/api/vle/agent/discard") {
    if (!body?.jobId) return sendJson(res, 400, { ok: false, reason: "missing jobId" });
    const result = discardJob(body.jobId);
    return sendJson(res, result.ok ? 200 : 422, result);
  }
  if (pathname === "/api/vle/agent/preview") {
    if (!body?.jobId) return sendJson(res, 400, { ok: false, reason: "missing jobId" });
    const result = await startPreview(body.jobId);
    return sendJson(res, result.ok ? 200 : 422, result);
  }
  if (pathname === "/api/vle/agent/refine") {
    if (!body?.jobId || !body?.prompt || !String(body.prompt).trim()) {
      return sendJson(res, 400, { ok: false, reason: "missing jobId/prompt" });
    }
    const result = refineJob(body.jobId, body.prompt);
    return sendJson(res, result.ok ? 200 : 422, result);
  }
  if (pathname === "/api/vle/chat") {
    const result = startChatSession(config);
    return sendJson(res, result.ok ? 200 : 422, result);
  }
  if (pathname === "/api/vle/chat/message") {
    if (!body?.chatId || !body?.text || !String(body.text).trim()) {
      return sendJson(res, 400, { ok: false, reason: "missing chatId/text" });
    }
    const result = sendChatMessage(body.chatId, body.text, config.repoRoot);
    return sendJson(res, result.ok ? 200 : 422, result);
  }
  if (pathname === "/api/vle/chat/apply") {
    if (!body?.chatId) return sendJson(res, 400, { ok: false, reason: "missing chatId" });
    const result = applyChatSession(body.chatId, config.repoRoot);
    return sendJson(res, result.ok ? 200 : 422, result);
  }
  if (pathname === "/api/vle/chat/discard") {
    if (!body?.chatId) return sendJson(res, 400, { ok: false, reason: "missing chatId" });
    const result = discardChatSession(body.chatId, config.repoRoot);
    return sendJson(res, result.ok ? 200 : 422, result);
  }
  if (pathname === "/api/vle/patch") {
    const patchBody = body as PatchRequest;
    if (!patchBody?.file || !patchBody?.kind) {
      return sendJson(res, 400, { ok: false, reason: "missing file/kind" });
    }
    if (patchBody.kind === "reorder") {
      if (!patchBody.draggedVleId || !patchBody.targetVleId || (patchBody.position !== "before" && patchBody.position !== "after")) {
        return sendJson(res, 400, { ok: false, reason: "missing draggedVleId/targetVleId/position" });
      }
    } else if (patchBody.kind === "insert") {
      if (!patchBody.targetVleId || (patchBody.position !== "before" && patchBody.position !== "after") || !patchBody.elementSnippet) {
        return sendJson(res, 400, { ok: false, reason: "missing targetVleId/position/elementSnippet" });
      }
    } else if (patchBody.kind === "delete" || patchBody.kind === "styleDelete") {
      if (!patchBody.vleId) return sendJson(res, 400, { ok: false, reason: "missing vleId" });
    } else {
      if (!patchBody.vleId) return sendJson(res, 400, { ok: false, reason: "missing vleId" });
      const value = patchBody.value;
      const valueOk = patchBody.kind === "style" ? typeof value === "number" || typeof value === "string" : typeof value === "string";
      if (!valueOk) {
        return sendJson(res, 400, { ok: false, reason: "value must be a string (className/text/style) or a number (style)" });
      }
    }

    const absPath = resolveProjectFile(config.projectRoot, patchBody.file);
    const before = absPath && fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : null;
    const result = applyPatch(config.projectRoot, patchBody);
    if (result.ok && absPath && before !== null) {
      const after = fs.readFileSync(absPath, "utf8");
      pushHistory(absPath, before, after);
    }
    return sendJson(res, result.ok ? 200 : 422, { ...result, ...historyStatus() });
  }
  if (pathname === "/api/vle/undo") {
    return sendJson(res, 200, undo());
  }
  if (pathname === "/api/vle/redo") {
    return sendJson(res, 200, redo());
  }
  if (pathname === "/api/vle/creatives/insert") {
    if (!body?.file || !body?.targetVleId || (body.position !== "before" && body.position !== "after") || !body?.creativeName || !body?.tag) {
      return sendJson(res, 400, { ok: false, reason: "missing file/targetVleId/position/creativeName/tag" });
    }
    const copied = copyCreativeToPublic(config, body.creativeName);
    if (!copied.ok) return sendJson(res, 422, { ok: false, reason: copied.reason });

    const elementSnippet =
      body.tag === "video"
        ? `<video src="${copied.publicPath}" autoPlay muted loop playsInline />`
        : `<img src="${copied.publicPath}" alt="" />`;

    const absPath = resolveProjectFile(config.projectRoot, body.file);
    const before = absPath && fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : null;
    const result = applyPatch(config.projectRoot, {
      file: body.file,
      kind: "insert",
      targetVleId: body.targetVleId,
      position: body.position,
      elementSnippet,
    });
    if (result.ok && absPath && before !== null) {
      const after = fs.readFileSync(absPath, "utf8");
      pushHistory(absPath, before, after);
    }
    return sendJson(res, result.ok ? 200 : 422, { ...result, publicPath: copied.publicPath, ...historyStatus() });
  }

  return sendJson(res, 404, { ok: false, reason: "not found" });
}

export default function vlePlugin(options: VlePluginOptions = {}): Plugin {
  let config: VleConfig;

  return {
    name: "vite-plugin-vle-editor",
    apply: "serve",
    enforce: "pre",
    // vle-editor/overlay/* ships as CommonJS — webpack (Next.js) handles that
    // transparently, but Vite's dev server only converts CJS to
    // browser-usable ESM for dependencies it pre-bundles via esbuild
    // (optimizeDeps). Found live: when `vle-editor` is installed as a symlink
    // (a local path/workspace install, not a real npm-registry install),
    // Vite's dependency crawler treats the resolved real path as project
    // "source" rather than "an installed dependency" and serves the raw
    // CJS file straight to the browser via /@fs/ — no interop shim, so its
    // require() calls throw immediately (white screen, no server-side
    // error to see). Forcing it into optimizeDeps.include sidesteps the
    // detection entirely: esbuild pre-bundles it (and, transitively, every
    // overlay/*.tsx file it imports) into real ESM ahead of time,
    // regardless of how it was resolved.
    config() {
      return {
        optimizeDeps: {
          include: ["vle-editor/overlay/VisualEditorOverlay"],
        },
        // Defense in depth alongside config.ts's own repoRoot auto-detection
        // (which now walks up to the real git top-level so a worktree
        // should never land inside a watched directory to begin with) —
        // found live: a worktree that DOES end up nested in the project
        // root (a misconfigured repoRoot, or a non-monorepo project where
        // .vle-worktrees legitimately sits right here) is a git worktree
        // add — potentially hundreds of files appearing at once, including
        // a nested copy of this very vite.config.ts. Vite treats a config
        // file change as grounds for a full reload/restart, which is
        // exactly the "page reloads the moment an agent job starts" bug
        // this was traced back to.
        server: {
          watch: {
            ignored: ["**/.vle-worktrees/**"],
          },
        },
      };
    },
    configResolved(resolvedConfig) {
      config = resolveConfig({ projectRoot: resolvedConfig.root, ...options });
    },
    // Instrumentation lives in `load`, not `transform`. Found live: even
    // with enforce: "pre" on our own transform hook, @vitejs/plugin-react
    // ALSO registers its main JSX/babel transform at enforce: "pre" (it's
    // "vite:react-babel" internally) — and among same-tier plugins, Vite
    // runs transform hooks in array order, so with the common
    // `plugins: [react(), vle()]` ordering, react's transform ran first
    // and rewrote the file (stripped TS types, added Fast Refresh
    // boilerplate, reformatted ternaries) before we ever saw it. We were
    // then hashing byte offsets in react-babel's rewritten copy, not the
    // real file — so every id embedded in the page was already wrong
    // before it ever reached the browser, and every patch attempt against
    // it failed server-side with "no element found", indistinguishable
    // from ordinary staleness until actually compared byte-for-byte
    // against the file on disk.
    //
    // `load` sidesteps the whole tiering question: it's the step that
    // supplies a module's *initial* content, strictly before any
    // transform hook (ours or anyone else's) runs. We read the file
    // straight off disk here and instrument it ourselves; the (still
    // spec-compliant, still-real-JSX) result then flows through
    // react-babel/esbuild exactly like any hand-written source would,
    // carrying our data-vle-* attributes along as ordinary JSX attributes.
    load(id) {
      if (process.env.NODE_ENV === "production") return null;
      // Same reasoning as the old transform hook's id handling — Vite
      // appends a cache-busting `?t=...` query after an HMR update, which
      // must be stripped before the extension check and before computing
      // relPath (an un-stripped query would end up embedded in the hash
      // input, silently producing different ids after the first edit).
      const cleanId = id.split("?")[0];
      if (!/\.[jt]sx$/.test(cleanId)) return null;
      if (cleanId.includes("/node_modules/")) return null;
      if (!fs.existsSync(cleanId)) return null;
      const source = fs.readFileSync(cleanId, "utf8");
      const relPath = path.relative(config.projectRoot, cleanId).split(path.sep).join("/");
      const result = instrumentJsx(source, relPath);
      if (!result) return null;
      return result.code;
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!(req.url ?? "").startsWith("/api/vle")) return next();
        try {
          await handleApi(req, res, config);
        } catch (err) {
          sendJson(res, 500, { ok: false, reason: (err as Error).message });
        }
      });
    },
  };
}
