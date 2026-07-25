/**
 * In-memory undo/redo stack for the visual editor's write-back edits.
 *
 * Deliberately stored on `globalThis`, not a module-level `let`: found live
 * — Next.js App Router compiles each route.ts as its own separate webpack
 * bundle, even in dev mode, so patch/route.ts and undo/route.ts each get
 * their OWN instance of this module's top-level scope. A plain
 * module-level array silently doesn't share state between them (undo saw
 * an empty stack right after patch had just pushed onto "its own" copy).
 * `globalThis` is the actual Node process-wide object, unaffected by
 * per-bundle module duplication — the standard fix for this class of
 * Next.js dev-mode issue (same reason singleton DB clients use it).
 *
 * Deliberately not persisted to disk: this is an editing-session
 * convenience, not a change-tracking system (git is already that, for
 * anything meant to survive a server restart).
 */
import fs from "node:fs";

interface HistoryEntry {
  absPath: string;
  before: string;
  after: string;
}

const MAX_HISTORY = 50;

const g = globalThis as unknown as { __vleUndoStack?: HistoryEntry[]; __vleRedoStack?: HistoryEntry[] };
g.__vleUndoStack ??= [];
g.__vleRedoStack ??= [];

function getStacks() {
  return { undoStack: g.__vleUndoStack!, redoStack: g.__vleRedoStack! };
}

export interface HistoryStatus {
  canUndo: boolean;
  canRedo: boolean;
}

export function historyStatus(): HistoryStatus {
  const { undoStack, redoStack } = getStacks();
  return { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
}

/** Call after every successful patch — a fresh edit invalidates any redo history. */
export function pushHistory(absPath: string, before: string, after: string): void {
  const { undoStack, redoStack } = getStacks();
  undoStack.push({ absPath, before, after });
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
}

export function undo(): { ok: boolean; reason?: string } & HistoryStatus {
  const { undoStack, redoStack } = getStacks();
  const entry = undoStack.pop();
  if (!entry) return { ok: false, reason: "nothing to undo", ...historyStatus() };
  fs.writeFileSync(entry.absPath, entry.before, "utf8");
  redoStack.push(entry);
  return { ok: true, ...historyStatus() };
}

export function redo(): { ok: boolean; reason?: string } & HistoryStatus {
  const { undoStack, redoStack } = getStacks();
  const entry = redoStack.pop();
  if (!entry) return { ok: false, reason: "nothing to redo", ...historyStatus() };
  fs.writeFileSync(entry.absPath, entry.after, "utf8");
  undoStack.push(entry);
  return { ok: true, ...historyStatus() };
}
