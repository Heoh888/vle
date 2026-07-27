"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ChatMessageView {
  role: "user" | "assistant";
  text: string;
  steps?: string[];
}

export interface ChatView {
  id: string;
  status: "idle" | "running" | "error";
  messages: ChatMessageView[];
  currentSteps: string[];
  sessionId?: string;
  createdAt: number;
  diffText?: string;
  diffStat?: string;
  lastCostUsd?: number;
  error?: string;
  previewPort?: number;
  previewStatus?: "starting" | "ready" | "error";
  previewError?: string;
}

export interface ChatSummaryView {
  id: string;
  status: "idle" | "running" | "error";
  preview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  lastCostUsd?: number;
  hasDiff: boolean;
}

/**
 * Pending context for the *next* message — a file dropped in via 📎, or a
 * page element picked via 📍. VisualEditorOverlay owns this state (it's
 * the one with document-level picker access) and folds it into the actual
 * outgoing text right before sending — this component only renders chips
 * and reports add/remove intent upward.
 */
export type ChatAttachment =
  | { kind: "file"; name: string; relPath: string }
  | { kind: "element"; file: string; lineNumber: number; snippet: string; label: string };

interface ChatPanelProps {
  chat: ChatView | null;
  onSend: (text: string) => void;
  onApply: () => void;
  onDiscard: () => void;
  onPreview: () => void;
  onClose: () => void;
  /** Fetches the "History" view's list — called fresh every time the view is switched to, deliberately not cached, so a chat's status/diff badge never shows stale info. */
  onLoadHistory: () => Promise<ChatSummaryView[]>;
  /** Switches the active chat: an id resumes that persisted session (GET /api/vle/chat?chatId=...), null starts fresh without discarding whatever was previously open — it stays alive on disk/in the History list either way. */
  onSelectChat: (chatId: string | null) => void;
  attachments: ChatAttachment[];
  onRemoveAttachment: (index: number) => void;
  onAttachFile: (file: File) => void;
  attachError: string | null;
  pickingElement: boolean;
  onToggleElementPicker: () => void;
}

function timeAgo(ms: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function statusBadge(status: ChatSummaryView["status"], hasDiff: boolean): { label: string; color: string } {
  if (status === "running") return { label: "● running", color: "#9b8ec4" };
  if (status === "error") return { label: "⚠ error", color: "#F87171" };
  if (hasDiff) return { label: "✓ has changes", color: "#34D399" };
  return { label: "idle", color: "#6B7280" };
}

function StepsBlock({ steps }: { steps: string[] }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  return (
    <div style={{ marginBottom: 4 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ background: "none", border: "none", color: "#6B7280", fontSize: 10, cursor: "pointer", padding: 0 }}
      >
        {open ? "▾" : "▸"} {steps.length} step{steps.length === 1 ? "" : "s"}
      </button>
      {open && (
        <div style={{ fontSize: 10, color: "#6B7280", marginTop: 2, lineHeight: 1.6 }}>
          {steps.map((s, i) => (
            <div key={i}>· {s}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Docked sidebar, not a floating popover — a chat implies "opened it, working
 * in it for a while," unlike AgentJobPanel's one-shot review. Backed by
 * chatRunner.ts: a multi-turn conversation in ITS OWN isolated worktree,
 * carried across turns via Claude Code's --resume, diff recomputed after
 * every turn (cumulative for the whole conversation). Apply/Discard end the
 * session — same worktree-then-diff-then-explicit-apply shape as
 * AgentJobPanel, just spanning a whole conversation instead of one message.
 */
export function ChatPanel({
  chat,
  onSend,
  onApply,
  onDiscard,
  onPreview,
  onClose,
  onLoadHistory,
  onSelectChat,
  attachments,
  onRemoveAttachment,
  onAttachFile,
  attachError,
  pickingElement,
  onToggleElementPicker,
}: ChatPanelProps) {
  const [text, setText] = useState("");
  const [view, setView] = useState<"chat" | "history">("chat");
  const [history, setHistory] = useState<ChatSummaryView[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chat?.messages.length, chat?.currentSteps.length]);

  const openHistory = () => {
    setView("history");
    setHistory(null);
    setHistoryError(null);
    onLoadHistory()
      .then(setHistory)
      .catch((err) => setHistoryError(String(err)));
  };

  const selectFromHistory = (id: string | null) => {
    onSelectChat(id);
    setView("chat");
  };

  const running = chat?.status === "running";

  const send = () => {
    if (!text.trim() || running) return;
    onSend(text);
    setText("");
  };

  return createPortal(
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        bottom: 0,
        width: 400,
        display: "flex",
        flexDirection: "column",
        background: "#111827",
        color: "white",
        borderRight: "1px solid #374151",
        zIndex: 999998,
        fontFamily: "system-ui, sans-serif",
        boxShadow: "4px 0 24px rgba(0,0,0,0.4)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 12, borderBottom: "1px solid #374151" }}>
        <strong style={{ fontSize: 13 }}>💭 Chat with agent</strong>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            onClick={() => (view === "history" ? setView("chat") : openHistory())}
            title="Past chats"
            style={{ background: "none", border: "none", color: view === "history" ? "var(--vle-accent, #9b8ec4)" : "#9CA3AF", cursor: "pointer", fontSize: 11 }}
          >
            🕘 History
          </button>
          <button
            onClick={() => selectFromHistory(null)}
            title="Start a new chat (this one stays saved)"
            style={{ background: "none", border: "none", color: "#9CA3AF", cursor: "pointer", fontSize: 11 }}
          >
            + New
          </button>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#9CA3AF", cursor: "pointer" }}>
            ✕
          </button>
        </div>
      </div>

      {view === "history" && (
        <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {historyError && <div style={{ fontSize: 12, color: "#F87171" }}>{historyError}</div>}
          {!history && !historyError && <div style={{ fontSize: 12, color: "#6B7280" }}>Loading…</div>}
          {history && history.length === 0 && !historyError && (
            <div style={{ fontSize: 12, color: "#6B7280" }}>No saved chats yet — anything you start sticks around here until you Apply or Discard it.</div>
          )}
          {history?.map((h) => {
            const badge = statusBadge(h.status, h.hasDiff);
            return (
              <button
                key={h.id}
                onClick={() => selectFromHistory(h.id)}
                style={{
                  textAlign: "left",
                  background: "#1F2937",
                  border: "1px solid #374151",
                  borderRadius: 6,
                  padding: "8px 10px",
                  cursor: "pointer",
                  color: "white",
                }}
              >
                <div style={{ fontSize: 12, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.preview}</div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#6B7280" }}>
                  <span style={{ color: badge.color }}>{badge.label}</span>
                  <span>
                    {h.messageCount} msg{h.messageCount === 1 ? "" : "s"} · {timeAgo(h.updatedAt)}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {view === "chat" && (
      <>
      <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        {!chat && (
          <div style={{ fontSize: 12, color: "#6B7280" }}>
            Ask a question ("do we handle mobile screens well?") or request a change — runs in an isolated worktree, nothing touches your live
            files until you hit Apply.
          </div>
        )}
        {chat?.messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%" }}>
            {m.role === "assistant" && m.steps && <StepsBlock steps={m.steps} />}
            <div
              style={{
                fontSize: 12,
                lineHeight: 1.5,
                padding: "8px 10px",
                borderRadius: 8,
                background: m.role === "user" ? "var(--vle-accent, #9b8ec4)" : "#1F2937",
                color: "white",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {m.text}
            </div>
          </div>
        ))}
        {running && (
          <div style={{ alignSelf: "flex-start", maxWidth: "88%" }}>
            <div style={{ fontSize: 11, color: "#9CA3AF", display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--vle-accent, #9b8ec4)",
                  display: "inline-block",
                  animation: "vle-pulse 1s ease-in-out infinite",
                }}
              />
              {chat?.currentSteps.length ? chat.currentSteps[chat.currentSteps.length - 1] : "Thinking…"}
            </div>
          </div>
        )}
        {chat?.status === "error" && chat.error && (
          <div style={{ fontSize: 12, color: "#F87171", padding: "8px 10px", borderRadius: 8, background: "#450A0A" }}>{chat.error}</div>
        )}
      </div>

      {chat?.diffText?.trim() && (
        <ChatDiffBar
          diffText={chat.diffText}
          diffStat={chat.diffStat}
          onApply={onApply}
          onDiscard={onDiscard}
          onPreview={onPreview}
          previewPort={chat.previewPort}
          previewStatus={chat.previewStatus}
          previewError={chat.previewError}
          disabled={running}
        />
      )}

      {(attachments.length > 0 || attachError) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 12px 0" }}>
          {attachments.map((a, i) => (
            <div
              key={i}
              title={a.kind === "file" ? a.name : a.snippet}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                fontSize: 10,
                background: "#1F2937",
                border: "1px solid #374151",
                borderRadius: 999,
                padding: "3px 8px",
                maxWidth: 160,
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {a.kind === "file" ? `📎 ${a.name}` : `📍 ${a.label}`}
              </span>
              <button
                onClick={() => onRemoveAttachment(i)}
                style={{ background: "none", border: "none", color: "#9CA3AF", cursor: "pointer", fontSize: 10, padding: 0, lineHeight: 1 }}
              >
                ✕
              </button>
            </div>
          ))}
          {attachError && <div style={{ fontSize: 10, color: "#F87171" }}>{attachError}</div>}
        </div>
      )}

      <div style={{ display: "flex", gap: 6, padding: 12, borderTop: "1px solid #374151" }}>
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onAttachFile(file);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={running}
          title="Attach a file"
          style={{ background: "none", border: "1px solid #374151", borderRadius: 4, color: running ? "#4B5563" : "#9CA3AF", cursor: running ? "default" : "pointer", padding: "0 10px", fontSize: 14 }}
        >
          📎
        </button>
        <button
          onClick={onToggleElementPicker}
          disabled={running}
          title="Pick an element on the page to attach"
          style={{
            background: "none",
            border: "1px solid " + (pickingElement ? "var(--vle-accent, #9b8ec4)" : "#374151"),
            borderRadius: 4,
            color: running ? "#4B5563" : pickingElement ? "var(--vle-accent, #9b8ec4)" : "#9CA3AF",
            cursor: running ? "default" : "pointer",
            padding: "0 10px",
            fontSize: 14,
          }}
        >
          📍
        </button>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={running ? "Agent is working…" : pickingElement ? "Pick an element…" : "Ask or request a change…"}
          disabled={running}
          rows={2}
          style={{ flex: 1, fontSize: 12, background: "#1F2937", color: "white", border: "1px solid #374151", borderRadius: 4, padding: 8, resize: "none" }}
        />
        <button
          onClick={send}
          disabled={!text.trim() || running}
          style={{
            fontSize: 12,
            padding: "0 14px",
            borderRadius: 4,
            border: "none",
            background: text.trim() && !running ? "var(--vle-accent, #9b8ec4)" : "#374151",
            color: "white",
            cursor: text.trim() && !running ? "pointer" : "default",
          }}
        >
          Send
        </button>
      </div>
      {chat && !chat.diffText?.trim() && chat.status !== "running" && (
        <div style={{ padding: "0 12px 8px", display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={onDiscard}
            style={{ fontSize: 11, padding: "4px 10px", borderRadius: 4, border: "1px solid #374151", background: "#1F2937", color: "#9CA3AF", cursor: "pointer" }}
          >
            End chat
          </button>
        </div>
      )}
      </>
      )}
      <style>{`@keyframes vle-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }`}</style>
    </div>,
    document.body
  );
}

function ChatDiffBar({
  diffText,
  diffStat,
  onApply,
  onDiscard,
  onPreview,
  previewPort,
  previewStatus,
  previewError,
  disabled,
}: {
  diffText: string;
  diffStat?: string;
  onApply: () => void;
  onDiscard: () => void;
  onPreview: () => void;
  previewPort?: number;
  previewStatus?: "starting" | "ready" | "error";
  previewError?: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: "1px solid #374151" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", flexWrap: "wrap" }}>
        <button onClick={() => setOpen((v) => !v)} style={{ background: "none", border: "none", color: "#9CA3AF", fontSize: 11, cursor: "pointer", padding: 0, flex: 1, textAlign: "left" }}>
          {open ? "▾" : "▸"} {diffStat?.trim() ? diffStat.trim().split("\n").pop() : "changes pending"}
        </button>
        {!previewStatus && (
          <button
            onClick={onPreview}
            disabled={disabled}
            style={{ fontSize: 11, padding: "4px 10px", borderRadius: 4, border: "1px solid #374151", background: "#1F2937", color: "white", cursor: disabled ? "default" : "pointer" }}
          >
            👁 Preview
          </button>
        )}
        {previewStatus === "starting" && <span style={{ fontSize: 10, color: "#9CA3AF" }}>Starting preview server…</span>}
        {previewStatus === "error" && (
          <span style={{ fontSize: 10, color: "#F87171" }} title={previewError}>
            preview failed
          </span>
        )}
        {previewStatus === "ready" && previewPort && (
          <a href={`http://127.0.0.1:${previewPort}/`} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "var(--vle-accent, #9b8ec4)" }}>
            Open in new tab ↗
          </a>
        )}
        <button
          onClick={onApply}
          disabled={disabled}
          style={{ fontSize: 11, padding: "4px 10px", borderRadius: 4, border: "none", background: disabled ? "#374151" : "var(--vle-accent, #9b8ec4)", color: "white", cursor: disabled ? "default" : "pointer" }}
        >
          Apply
        </button>
        <button
          onClick={onDiscard}
          disabled={disabled}
          style={{ fontSize: 11, padding: "4px 10px", borderRadius: 4, border: "1px solid #374151", background: "#1F2937", color: "white", cursor: disabled ? "default" : "pointer" }}
        >
          Discard
        </button>
      </div>
      {open && (
        <pre style={{ margin: 0, padding: 12, fontSize: 10, lineHeight: 1.5, maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", borderTop: "1px solid #374151" }}>
          {diffText}
        </pre>
      )}
    </div>
  );
}
