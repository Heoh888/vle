/**
 * Multi-turn chat with a headless Claude Code agent, in its own isolated
 * worktree per conversation — the "global chat" counterpart to
 * agentRunner.ts's single-comment jobs (not tied to a clicked element, and
 * a message may just be a question, not a request to change anything).
 *
 * Shares worktree/process-tree mechanics with agentRunner.ts
 * (createWorktree, cleanupWorktree, killProcessTree) — those are generic,
 * nothing about them is comment-job-specific. What's different here is how
 * each turn's output is consumed: `--output-format stream-json` (JSONL,
 * one event per line) parsed incrementally as it arrives, so tool-use steps
 * ("Reading X…") can be shown live instead of only learning the result once
 * the whole turn finishes (agentRunner.ts's jobs use the simpler
 * `--output-format json`, one object at process close, since there's no
 * live-step UI to feed there).
 */
import { randomUUID } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { buildChatPrompt } from "./agentPrompt";
import { createWorktree, cleanupWorktree, killProcessTree } from "./agentRunner";
import type { VleConfig } from "./config";

const MAX_BUDGET_USD = "2";
const TIMEOUT_MS = 10 * 60 * 1000;

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  steps?: string[];
}

interface ChatSession {
  id: string;
  status: "idle" | "running" | "error";
  messages: ChatMessage[];
  currentSteps: string[];
  sessionId?: string;
  worktreePath: string;
  branch: string;
  repoRoot: string;
  promptContext: string;
  pathAnchors: string[];
  creativesDir: string;
  createdAt: number;
  updatedAt: number;
  diffText?: string;
  diffStat?: string;
  lastCostUsd?: number;
  error?: string;
}

const CHATS_DIRNAME = ".vle-chats";

function chatsDir(repoRoot: string): string {
  return path.join(repoRoot, CHATS_DIRNAME);
}

function chatFilePath(repoRoot: string, chatId: string): string {
  return path.join(chatsDir(repoRoot), `${chatId}.json`);
}

/**
 * Flushes a session to `<repoRoot>/.vle-chats/<id>.json` so it survives a
 * page refresh (client loses its only reference to chatId) or a dev-server
 * restart (in-memory sessions() Map is gone) — see loadPersistedSession
 * and listChatSessions. Called after every state transition worth
 * remembering (session creation, end of each turn); deliberately NOT
 * called when a turn starts (status flips to "running") — a server
 * restart mid-turn would otherwise leave a persisted "running" status with
 * no process behind it, stuck forever with no way to recover short of
 * Discard.
 */
function persistSession(session: ChatSession): void {
  session.updatedAt = Date.now();
  try {
    fs.mkdirSync(chatsDir(session.repoRoot), { recursive: true });
    fs.writeFileSync(chatFilePath(session.repoRoot, session.id), JSON.stringify(session), "utf8");
  } catch {
    // Best-effort — persistence is a convenience on top of the in-memory
    // session, not a correctness requirement for the turn that's running.
  }
}

function loadPersistedSession(repoRoot: string, chatId: string): ChatSession | null {
  try {
    return JSON.parse(fs.readFileSync(chatFilePath(repoRoot, chatId), "utf8")) as ChatSession;
  } catch {
    return null;
  }
}

/** Looks in memory first, falls back to disk (and rehydrates the in-memory map) — the one path every public function below goes through so none of them need to care which case they're in. */
function hydrateSession(chatId: string, repoRoot: string): ChatSession | undefined {
  let session = sessions().get(chatId);
  if (!session) {
    const loaded = loadPersistedSession(repoRoot, chatId);
    if (loaded) {
      sessions().set(chatId, loaded);
      session = loaded;
    }
  }
  return session;
}

export interface ChatSummary {
  id: string;
  status: "idle" | "running" | "error";
  preview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  lastCostUsd?: number;
  hasDiff: boolean;
}

/** Reads every persisted session under .vle-chats/ — the browsable "history" list. Sessions that are still Applied/Discarded have their file removed, so this only ever shows chats still worth resuming. */
export function listChatSessions(repoRoot: string): ChatSummary[] {
  let files: string[];
  try {
    files = fs.readdirSync(chatsDir(repoRoot)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const summaries: ChatSummary[] = [];
  for (const f of files) {
    try {
      const session: ChatSession = JSON.parse(fs.readFileSync(path.join(chatsDir(repoRoot), f), "utf8"));
      const firstUserText = session.messages.find((m) => m.role === "user")?.text ?? "(new chat)";
      summaries.push({
        id: session.id,
        status: session.status,
        preview: firstUserText.length > 60 ? `${firstUserText.slice(0, 60)}…` : firstUserText,
        messageCount: session.messages.length,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt ?? session.createdAt,
        lastCostUsd: session.lastCostUsd,
        hasDiff: !!session.diffText?.trim(),
      });
    } catch {
      // A corrupt/partially-written file shouldn't take down the whole list — skip it.
    }
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

const g = globalThis as unknown as {
  __vleChatSessions?: Map<string, ChatSession>;
  __vleChatChildren?: Map<string, ChildProcess>;
};
g.__vleChatSessions ??= new Map();
g.__vleChatChildren ??= new Map();

function sessions(): Map<string, ChatSession> {
  return g.__vleChatSessions!;
}
function children(): Map<string, ChildProcess> {
  return g.__vleChatChildren!;
}

export interface ChatPublicView {
  id: string;
  status: "idle" | "running" | "error";
  messages: ChatMessage[];
  currentSteps: string[];
  sessionId?: string;
  createdAt: number;
  diffText?: string;
  diffStat?: string;
  lastCostUsd?: number;
  error?: string;
}

export function startChatSession(config: VleConfig): { ok: true; chatId: string } | { ok: false; reason: string } {
  const chatId = randomUUID();
  const created = createWorktree(config.repoRoot, chatId, "vle-chat");
  if (!created.ok) return created;

  const session: ChatSession = {
    id: chatId,
    status: "idle",
    messages: [],
    currentSteps: [],
    worktreePath: created.worktreePath,
    branch: created.branch,
    repoRoot: config.repoRoot,
    promptContext: config.promptContext,
    pathAnchors: config.pathAnchors,
    creativesDir: config.creativesDir,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  sessions().set(chatId, session);
  persistSession(session);
  return { ok: true, chatId };
}

export function getChatStatus(chatId: string, repoRoot: string): ChatPublicView | null {
  const session = hydrateSession(chatId, repoRoot);
  if (!session) return null;
  const { worktreePath: _worktreePath, branch: _branch, repoRoot: _repoRoot, promptContext: _promptContext, pathAnchors: _pathAnchors, creativesDir: _creativesDir, updatedAt: _updatedAt, ...pub } = session;
  return pub;
}

/** Absolute paths inside a worktree are noisy in a step log — trims back to a project-relative-looking path at the first recognizable anchor segment. */
function shortenPath(p: unknown, anchors: string[]): string {
  if (typeof p !== "string" || !p) return "a file";
  for (const a of anchors) {
    const idx = p.indexOf(a);
    if (idx >= 0) return p.slice(idx + 1);
  }
  const parts = p.split("/");
  return parts.slice(-2).join("/");
}

function describeToolUse(name: string, input: any, anchors: string[]): string {
  switch (name) {
    case "Read":
      return `Reading ${shortenPath(input?.file_path, anchors)}`;
    case "Grep":
      return `Searching for "${input?.pattern ?? ""}"`;
    case "Glob":
      return `Finding files matching ${input?.pattern ?? ""}`;
    case "Edit":
      return `Editing ${shortenPath(input?.file_path, anchors)}`;
    case "Write":
      return `Writing ${shortenPath(input?.file_path, anchors)}`;
    case "Bash":
      return `Running: ${String(input?.command ?? "").slice(0, 60)}`;
    default:
      return `Using ${name}`;
  }
}

function finalizeTurn(session: ChatSession, resultLine: any): void {
  const failed = !resultLine || resultLine.is_error;

  if (!failed) {
    const text = typeof resultLine.result === "string" ? resultLine.result : "";
    session.messages.push({ role: "assistant", text, steps: session.currentSteps });
    if (typeof resultLine.session_id === "string") session.sessionId = resultLine.session_id;
    if (typeof resultLine.total_cost_usd === "number") session.lastCostUsd = resultLine.total_cost_usd;
  }
  session.currentSteps = [];

  // Compute the diff regardless of whether the turn cleanly finished —
  // found live: a large "generate a design system" instruction hit
  // --max-budget-usd mid-turn, which kills the process before it ever
  // emits a stream-json "result" line, taking this straight to the
  // `failed` branch — but real files had already been written to the
  // worktree by then. Treating any failure as "nothing to show" would
  // silently throw away real, possibly-costly work; Discard is still one
  // click away if it's genuinely not wanted.
  try {
    execFileSync("git", ["add", "-A"], { cwd: session.worktreePath, stdio: "pipe" });
    session.diffText = execFileSync("git", ["diff", "--cached", "--binary"], { cwd: session.worktreePath, maxBuffer: 1024 * 1024 * 64 }).toString("utf8");
    session.diffStat = execFileSync("git", ["diff", "--cached", "--stat"], { cwd: session.worktreePath, maxBuffer: 1024 * 1024 * 64 }).toString("utf8");
  } catch {
    // Best-effort — if this also fails there's genuinely nothing to show.
  }

  if (failed) {
    session.status = "error";
    session.error =
      (resultLine && typeof resultLine.result === "string" && resultLine.result) ||
      "the agent turn ended unexpectedly (may have hit its budget/time cap) — any partial progress is shown below, review before deciding.";
  } else {
    session.status = "idle";
  }

  persistSession(session);
}

function runChatTurn(session: ChatSession, promptText: string): void {
  const args = [
    "-p",
    promptText,
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--model",
    "sonnet",
    "--max-budget-usd",
    MAX_BUDGET_USD,
  ];
  if (session.sessionId) args.push("--resume", session.sessionId);

  const child = spawn("claude", args, { cwd: session.worktreePath, stdio: ["ignore", "pipe", "pipe"], detached: true });
  children().set(session.id, child);

  let resultLine: any = null;
  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return; // stream-json is one complete JSON object per line — a bad parse means a stray/partial line, skip it
    }
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "tool_use") {
          session.currentSteps.push(describeToolUse(block.name, block.input, session.pathAnchors));
        }
      }
    } else if (event.type === "result") {
      resultLine = event;
    }
  });

  const timeoutHandle = setTimeout(() => killProcessTree(child), TIMEOUT_MS);

  child.on("close", () => {
    clearTimeout(timeoutHandle);
    children().delete(session.id);
    rl.close();
    finalizeTurn(session, resultLine);
  });

  child.on("error", (err) => {
    clearTimeout(timeoutHandle);
    children().delete(session.id);
    session.status = "error";
    session.error = `failed to spawn claude: ${err.message}`;
  });
}

export function sendChatMessage(chatId: string, text: string, repoRoot: string): { ok: true } | { ok: false; reason: string } {
  const session = hydrateSession(chatId, repoRoot);
  if (!session) return { ok: false, reason: "chat session not found" };
  if (session.status === "running") return { ok: false, reason: "a turn is already running" };

  session.messages.push({ role: "user", text });
  session.status = "running";
  session.currentSteps = [];
  session.error = undefined;

  // First message frames the whole conversation (project context, "may
  // just be a question"); every message after that is resumed via
  // --resume, so the model already has that framing — sending it again
  // would just be noise, same reasoning as agentRunner.ts's refineJob.
  const promptText = session.sessionId ? text : buildChatPrompt(session.promptContext, text, session.creativesDir);
  runChatTurn(session, promptText);
  return { ok: true };
}

function removePersistedSession(session: ChatSession): void {
  try {
    fs.rmSync(chatFilePath(session.repoRoot, session.id), { force: true });
  } catch {
    // Best-effort — a leftover .vle-chats/<id>.json is harmless (gitignored), not worth failing Apply/Discard over.
  }
}

export function applyChatSession(chatId: string, repoRoot: string): { ok: true } | { ok: false; reason: string } {
  const session = hydrateSession(chatId, repoRoot);
  if (!session) return { ok: false, reason: "chat session not found" };
  if (session.status === "running") return { ok: false, reason: "a turn is still running" };
  if (!session.diffText || !session.diffText.trim()) return { ok: false, reason: "no changes to apply" };

  const patchFile = path.join(os.tmpdir(), `vle-chat-apply-${chatId}.patch`);
  fs.writeFileSync(patchFile, session.diffText, "utf8");

  try {
    execFileSync("git", ["apply", "--check", patchFile], { cwd: session.repoRoot, stdio: "pipe" });
    execFileSync("git", ["apply", patchFile], { cwd: session.repoRoot, stdio: "pipe" });
  } catch (err) {
    fs.rmSync(patchFile, { force: true });
    return { ok: false, reason: `patch no longer applies cleanly (live files may have changed since the conversation started): ${(err as Error).message}` };
  }

  fs.rmSync(patchFile, { force: true });
  cleanupWorktree(session);
  removePersistedSession(session);
  sessions().delete(chatId);
  return { ok: true };
}

export function discardChatSession(chatId: string, repoRoot: string): { ok: true } | { ok: false; reason: string } {
  const session = hydrateSession(chatId, repoRoot);
  if (!session) return { ok: false, reason: "chat session not found" };

  const child = children().get(chatId);
  if (child) {
    killProcessTree(child);
    children().delete(chatId);
  }

  cleanupWorktree(session);
  removePersistedSession(session);
  sessions().delete(chatId);
  return { ok: true };
}
