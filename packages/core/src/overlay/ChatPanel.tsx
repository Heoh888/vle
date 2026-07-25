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
}

interface ChatPanelProps {
  chat: ChatView | null;
  onSend: (text: string) => void;
  onApply: () => void;
  onDiscard: () => void;
  onClose: () => void;
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
export function ChatPanel({ chat, onSend, onApply, onDiscard, onClose }: ChatPanelProps) {
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chat?.messages.length, chat?.currentSteps.length]);

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
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#9CA3AF", cursor: "pointer" }}>
          ✕
        </button>
      </div>

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
        <ChatDiffBar diffText={chat.diffText} diffStat={chat.diffStat} onApply={onApply} onDiscard={onDiscard} disabled={running} />
      )}

      <div style={{ display: "flex", gap: 6, padding: 12, borderTop: "1px solid #374151" }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={running ? "Agent is working…" : "Ask or request a change…"}
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
      <style>{`@keyframes vle-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }`}</style>
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
    </div>,
    document.body
  );
}

function ChatDiffBar({ diffText, diffStat, onApply, onDiscard, disabled }: {
  diffText: string;
  diffStat?: string;
  onApply: () => void;
  onDiscard: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: "1px solid #374151" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px" }}>
        <button onClick={() => setOpen((v) => !v)} style={{ background: "none", border: "none", color: "#9CA3AF", fontSize: 11, cursor: "pointer", padding: 0, flex: 1, textAlign: "left" }}>
          {open ? "▾" : "▸"} {diffStat?.trim() ? diffStat.trim().split("\n").pop() : "changes pending"}
        </button>
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
