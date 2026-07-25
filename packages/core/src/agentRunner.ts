/**
 * Orchestrates a headless Claude Code agent run, triggered from the visual
 * editor's comment pin: creates an isolated git worktree (mirroring the
 * live repo's uncommitted state, not just HEAD — see propagateUncommittedState),
 * spawns `claude -p` in it with file edits auto-approved, and exposes the
 * result as a diff for the UI to review before Apply/Discard.
 *
 * Job records live on `globalThis`, same reason as history.ts: Next.js App
 * Router compiles each route.ts as its own webpack bundle even in dev, so a
 * plain module-level Map wouldn't be shared between the start/status/apply/
 * discard routes.
 */
import { randomUUID } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { locateElement, buildAgentPrompt } from "./agentPrompt";
import type { VleConfig } from "./config";

const MAX_BUDGET_USD = "2";
const TIMEOUT_MS = 10 * 60 * 1000;
const PREVIEW_READY_TIMEOUT_MS = 45 * 1000;
const PREVIEW_POLL_INTERVAL_MS = 700;

interface JobRecord {
  id: string;
  file: string;
  prompt: string;
  status: "running" | "done" | "error";
  worktreePath: string;
  branch: string;
  repoRoot: string;
  /** `projectRoot`'s path relative to `repoRoot` — see VleConfig.appDir. Needed to relocate the app dir inside this job's worktree (preview server, node_modules symlink). */
  appDir: string;
  startedAt: number;
  finishedAt?: number;
  resultText?: string;
  diffText?: string;
  diffStat?: string;
  costUsd?: number;
  error?: string;
  previewPort?: number;
  previewStatus?: "starting" | "ready" | "error";
  previewError?: string;
  sessionId?: string;
}

const g = globalThis as unknown as {
  __vleAgentJobs?: Map<string, JobRecord>;
  __vleAgentChildren?: Map<string, ChildProcess>;
  __vleAgentPreviewProcesses?: Map<string, ChildProcess>;
};
g.__vleAgentJobs ??= new Map();
g.__vleAgentChildren ??= new Map();
g.__vleAgentPreviewProcesses ??= new Map();

function jobs(): Map<string, JobRecord> {
  return g.__vleAgentJobs!;
}
function children(): Map<string, ChildProcess> {
  return g.__vleAgentChildren!;
}
function previewProcesses(): Map<string, ChildProcess> {
  return g.__vleAgentPreviewProcesses!;
}

export interface StartAgentJobRequest {
  file: string;
  vleId: string;
  prompt: string;
}

export type StartResult = { ok: true; jobId: string } | { ok: false; reason: string };

export interface JobPublicView {
  id: string;
  file: string;
  prompt: string;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  resultText?: string;
  diffText?: string;
  diffStat?: string;
  costUsd?: number;
  error?: string;
  previewPort?: number;
  previewStatus?: "starting" | "ready" | "error";
  previewError?: string;
  sessionId?: string;
}

/**
 * Copies the live repo's uncommitted state into a fresh worktree. A plain
 * `git worktree add ... HEAD` only gives the agent the last *committed*
 * snapshot — missing whatever the user just changed live and hasn't
 * committed (the exact scenario this feature exists for: "I just added
 * this button, wire it up").
 */
export function propagateUncommittedState(repoRoot: string, worktreePath: string): void {
  let diff = "";
  try {
    diff = execFileSync("git", ["diff", "HEAD"], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 64 }).toString("utf8");
  } catch {
    diff = "";
  }
  if (diff.trim()) {
    const patchFile = path.join(os.tmpdir(), `vle-uncommitted-${randomUUID()}.patch`);
    fs.writeFileSync(patchFile, diff, "utf8");
    try {
      execFileSync("git", ["apply", patchFile], { cwd: worktreePath, stdio: "pipe" });
    } catch {
      // Best-effort: the agent still gets the last-committed snapshot even
      // if this fails (e.g. a patch context mismatch) — not worth aborting
      // the whole job over.
    }
    fs.rmSync(patchFile, { force: true });
  }

  let untracked: string[] = [];
  try {
    const out = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024 * 64,
    }).toString("utf8");
    untracked = out.split("\n").filter(Boolean);
  } catch {
    untracked = [];
  }
  for (const rel of untracked) {
    try {
      const dest = path.join(worktreePath, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, rel), dest);
    } catch {
      // Best-effort per file (e.g. a broken symlink) — skip, don't abort the job.
    }
  }
}

/**
 * `next dev` internally forks a `next-server` child of its own to actually
 * serve requests — found live: killing only the direct child (what
 * child_process.spawn returns) left that grandchild orphaned (reparented to
 * PID 1) and still bound to the port after discard/apply. The preview
 * process is spawned with `detached: true` specifically so it gets its own
 * process group (pgid === its own pid); killing the *group* via a negative
 * pid reaches every descendant, not just the immediate child.
 */
export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Group may already be gone (process exited on its own) — fine.
  }
}

function killPreview(jobId: string): void {
  const child = previewProcesses().get(jobId);
  if (child) {
    killProcessTree(child);
    previewProcesses().delete(jobId);
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("failed to allocate a port"));
      }
    });
  });
}

/** Fire-and-forget: flips previewStatus to "ready"/"error" once the server responds or times out — not awaited by startPreview, same background-polling shape as the agent job itself. */
function pollPreviewReady(record: JobRecord, jobId: string, port: number): void {
  const deadline = Date.now() + PREVIEW_READY_TIMEOUT_MS;
  const tick = async () => {
    if (record.previewStatus !== "starting") return; // already resolved, or job moved on (apply/discard)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.status < 500) {
        record.previewStatus = "ready";
        return;
      }
    } catch {
      // Not up yet — keep polling.
    }
    if (Date.now() > deadline) {
      record.previewStatus = "error";
      record.previewError = "preview server didn't become ready in time";
      killPreview(jobId);
      return;
    }
    setTimeout(tick, PREVIEW_POLL_INTERVAL_MS);
  };
  setTimeout(tick, PREVIEW_POLL_INTERVAL_MS);
}

export function cleanupWorktree(record: { worktreePath: string; branch: string; repoRoot: string }): void {
  try {
    execFileSync("git", ["worktree", "remove", record.worktreePath, "--force"], { cwd: record.repoRoot, stdio: "pipe" });
  } catch {
    // Best-effort — a leftover worktree dir is gitignored and harmless, not worth failing over.
  }
  try {
    execFileSync("git", ["branch", "-D", record.branch], { cwd: record.repoRoot, stdio: "pipe" });
  } catch {
    // Same.
  }
}

export type CreateWorktreeResult = { ok: true; worktreePath: string; branch: string } | { ok: false; reason: string };

/**
 * Shared by both single-comment jobs (agentRunner.ts) and the multi-turn
 * chat (chatRunner.ts) — a fresh worktree mirroring the live repo's
 * uncommitted state, with that mirrored state committed as a baseline so
 * every later `git diff` in the worktree reflects only what happens next,
 * not the noise carried over at creation time (see propagateUncommittedState's
 * doc comment for why the mirroring itself matters).
 */
export function createWorktree(repoRoot: string, id: string, branchPrefix: string): CreateWorktreeResult {
  const branch = `${branchPrefix}/${id}`;
  const worktreePath = path.join(repoRoot, ".vle-worktrees", id);

  try {
    fs.mkdirSync(path.join(repoRoot, ".vle-worktrees"), { recursive: true });
    execFileSync("git", ["worktree", "add", "-b", branch, worktreePath, "HEAD"], { cwd: repoRoot, stdio: "pipe" });
  } catch (err) {
    return { ok: false, reason: `failed to create worktree: ${(err as Error).message}` };
  }

  propagateUncommittedState(repoRoot, worktreePath);

  try {
    execFileSync("git", ["add", "-A"], { cwd: worktreePath, stdio: "pipe" });
    execFileSync("git", ["commit", "--no-verify", "--allow-empty", "-m", "vle baseline: mirror of live working tree"], {
      cwd: worktreePath,
      stdio: "pipe",
    });
  } catch (err) {
    cleanupWorktree({ worktreePath, branch, repoRoot });
    return { ok: false, reason: `failed to snapshot baseline: ${(err as Error).message}` };
  }

  return { ok: true, worktreePath, branch };
}

function finishJob(record: JobRecord, stdout: string, stderr: string, exitCode: number | null): void {
  record.finishedAt = Date.now();

  let parsed: any = null;
  try {
    const lastLine = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    parsed = JSON.parse(lastLine);
  } catch {
    parsed = null;
  }

  if (!parsed || parsed.is_error) {
    record.status = "error";
    record.error = (parsed && typeof parsed.result === "string" && parsed.result) || stderr.slice(-2000) || `claude exited with code ${exitCode}`;
    return;
  }

  record.resultText = typeof parsed.result === "string" ? parsed.result : "";
  record.costUsd = typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined;
  if (typeof parsed.session_id === "string") record.sessionId = parsed.session_id;

  // Stage everything so files the agent *created* show up in the diff too —
  // `git diff` alone ignores untracked (new) files.
  try {
    execFileSync("git", ["add", "-A"], { cwd: record.worktreePath, stdio: "pipe" });
    record.diffText = execFileSync("git", ["diff", "--cached"], { cwd: record.worktreePath, maxBuffer: 1024 * 1024 * 64 }).toString("utf8");
    record.diffStat = execFileSync("git", ["diff", "--cached", "--stat"], { cwd: record.worktreePath, maxBuffer: 1024 * 1024 * 64 }).toString("utf8");
    record.status = "done";
  } catch (err) {
    record.status = "error";
    record.error = `agent finished but computing the diff failed: ${(err as Error).message}`;
  }
}

// Session persistence is required here — omitting it (the original design)
// meant a follow-up "actually make it faster" had no prior session to
// --resume, so each request restarted from zero context. Kept only for
// jobs on this tool's own throwaway worktrees, not the user's real dev
// session, so the extra saved-session files are low-cost.
function runAgent(record: JobRecord, promptText: string, resumeSessionId?: string): void {
  const args = [
    "-p",
    promptText,
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--model",
    "sonnet",
    "--max-budget-usd",
    MAX_BUDGET_USD,
  ];
  if (resumeSessionId) args.push("--resume", resumeSessionId);

  const child = spawn(
    "claude",
    args,
    // detached: true — same reason as the preview server (see killProcessTree):
    // the agent's own Bash tool can spawn further children (e.g. a dev
    // server it decides to start to check its work), and a plain kill() on
    // just this process wouldn't reach those.
    { cwd: record.worktreePath, stdio: ["ignore", "pipe", "pipe"], detached: true }
  );
  children().set(record.id, child);

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => (stdout += d.toString("utf8")));
  child.stderr?.on("data", (d) => (stderr += d.toString("utf8")));

  const timeoutHandle = setTimeout(() => killProcessTree(child), TIMEOUT_MS);

  child.on("close", (code) => {
    clearTimeout(timeoutHandle);
    children().delete(record.id);
    finishJob(record, stdout, stderr, code);
  });

  child.on("error", (err) => {
    clearTimeout(timeoutHandle);
    children().delete(record.id);
    record.status = "error";
    record.error = `failed to spawn claude: ${err.message}`;
    record.finishedAt = Date.now();
  });
}

export function startAgentJob(config: VleConfig, req: StartAgentJobRequest): StartResult {
  const located = locateElement(config.projectRoot, req.file, req.vleId);
  if ("reason" in located) return { ok: false, reason: located.reason };

  const jobId = randomUUID();

  const created = createWorktree(config.repoRoot, jobId, "vle-agent");
  if (!created.ok) return created;
  const { worktreePath, branch } = created;

  const fullPrompt = buildAgentPrompt(config.promptContext, located, req.prompt);
  const record: JobRecord = {
    id: jobId,
    file: req.file,
    prompt: req.prompt,
    status: "running",
    worktreePath,
    branch,
    repoRoot: config.repoRoot,
    appDir: config.appDir,
    startedAt: Date.now(),
  };
  jobs().set(jobId, record);
  runAgent(record, fullPrompt);

  return { ok: true, jobId };
}

export function getJobStatus(jobId: string): JobPublicView | null {
  const record = jobs().get(jobId);
  if (!record) return null;
  const { worktreePath: _worktreePath, branch: _branch, repoRoot: _repoRoot, appDir: _appDir, ...pub } = record;
  return pub;
}

/**
 * Continues the same session in the same worktree — not a fresh worktree/
 * baseline. The follow-up prompt is sent raw (via --resume), not re-wrapped
 * through buildAgentPrompt: the model already has the original framing +
 * file location from the resumed session, re-sending it would be noise.
 * The diff/apply that follows still spans everything since the *original*
 * baseline commit, so it's always the cumulative result of the whole
 * conversation, not just this one follow-up's delta.
 */
export function refineJob(jobId: string, prompt: string): { ok: true } | { ok: false; reason: string } {
  const record = jobs().get(jobId);
  if (!record) return { ok: false, reason: "job not found" };
  if (record.status !== "done") return { ok: false, reason: `job is ${record.status}, not done` };
  if (!record.sessionId) return { ok: false, reason: "this job has no resumable session — reload and retry" };

  killPreview(jobId);
  record.status = "running";
  record.prompt = `${record.prompt}\n[follow-up] ${prompt}`;
  record.diffText = undefined;
  record.diffStat = undefined;
  record.previewPort = undefined;
  record.previewStatus = undefined;
  record.previewError = undefined;

  runAgent(record, prompt, record.sessionId);
  return { ok: true };
}

export async function startPreview(jobId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const record = jobs().get(jobId);
  if (!record) return { ok: false, reason: "job not found" };
  if (record.status !== "done") return { ok: false, reason: `job is ${record.status}, not done` };
  if (previewProcesses().has(jobId)) return { ok: true }; // already starting/running — idempotent

  const appDir = path.join(record.worktreePath, record.appDir);
  const nodeModulesLink = path.join(appDir, "node_modules");
  if (!fs.existsSync(nodeModulesLink)) {
    try {
      fs.symlinkSync(path.join(record.repoRoot, record.appDir, "node_modules"), nodeModulesLink, "dir");
    } catch (err) {
      const reason = `failed to link node_modules: ${(err as Error).message}`;
      record.previewStatus = "error";
      record.previewError = reason;
      return { ok: false, reason };
    }
  }

  let port: number;
  try {
    port = await getFreePort();
  } catch (err) {
    const reason = `failed to allocate a port: ${(err as Error).message}`;
    record.previewStatus = "error";
    record.previewError = reason;
    return { ok: false, reason };
  }

  record.previewPort = port;
  record.previewStatus = "starting";
  record.previewError = undefined;

  const nextBin = path.join(appDir, "node_modules", ".bin", "next");
  // detached: true — required for killProcessTree to work: `next dev` forks
  // its own `next-server` child to actually serve requests, so this process
  // alone isn't the whole story (see killProcessTree's comment).
  const child = spawn(nextBin, ["dev", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: appDir,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, VLE_PREVIEW: "1" },
  });
  previewProcesses().set(jobId, child);

  child.on("error", (err) => {
    record.previewStatus = "error";
    record.previewError = `failed to start preview server: ${err.message}`;
    previewProcesses().delete(jobId);
  });
  child.on("exit", () => {
    if (record.previewStatus === "starting") {
      record.previewStatus = "error";
      record.previewError = "preview server exited before becoming ready";
    }
    previewProcesses().delete(jobId);
  });

  pollPreviewReady(record, jobId, port);

  return { ok: true };
}

export function applyJob(jobId: string): { ok: true } | { ok: false; reason: string } {
  const record = jobs().get(jobId);
  if (!record) return { ok: false, reason: "job not found" };
  if (record.status !== "done") return { ok: false, reason: `job is ${record.status}, not done` };
  if (!record.diffText || !record.diffText.trim()) return { ok: false, reason: "no changes to apply" };

  const patchFile = path.join(os.tmpdir(), `vle-agent-apply-${jobId}.patch`);
  fs.writeFileSync(patchFile, record.diffText, "utf8");

  try {
    execFileSync("git", ["apply", "--check", patchFile], { cwd: record.repoRoot, stdio: "pipe" });
    execFileSync("git", ["apply", patchFile], { cwd: record.repoRoot, stdio: "pipe" });
  } catch (err) {
    fs.rmSync(patchFile, { force: true });
    return { ok: false, reason: `patch no longer applies cleanly (live files may have changed since the job ran): ${(err as Error).message}` };
  }

  fs.rmSync(patchFile, { force: true });
  killPreview(jobId);
  cleanupWorktree(record);
  jobs().delete(jobId);
  return { ok: true };
}

export function discardJob(jobId: string): { ok: true } | { ok: false; reason: string } {
  const record = jobs().get(jobId);
  if (!record) return { ok: false, reason: "job not found" };

  const child = children().get(jobId);
  if (child) {
    killProcessTree(child);
    children().delete(jobId);
  }
  killPreview(jobId);

  cleanupWorktree(record);
  jobs().delete(jobId);
  return { ok: true };
}
