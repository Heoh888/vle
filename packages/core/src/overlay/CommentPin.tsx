"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { fileAndIdFor } from "./patchClient";

interface CommentPinProps {
  el: HTMLElement;
  onStarted: (jobId: string) => void;
  onClose: () => void;
}

/**
 * The floating "leave a comment" box that appears once an element is picked
 * in comment mode — portaled to document.body (same reason as FillPanel:
 * escapes any parent's overflow/width clipping), anchored just below the
 * picked element. Submitting kicks off a background agent job; the actual
 * running/done/diff-review UI lives in AgentJobPanel, not here — this
 * component's only job is capturing the request and closing.
 */
export function CommentPin({ el, onStarted, onClose }: CommentPinProps) {
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rect = el.getBoundingClientRect();
  const panelWidth = 300;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - panelWidth - 8);
  const top = Math.min(rect.bottom + 8, window.innerHeight - 160);

  const submit = async () => {
    if (!prompt.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    const { file, vleId } = fileAndIdFor(el);
    try {
      const res = await fetch("/api/vle/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file, vleId, prompt }),
      });
      const result = await res.json();
      if (!result.ok) {
        setError(result.reason ?? "failed to start agent job");
        setSubmitting(false);
        return;
      }
      onStarted(result.jobId);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      style={{
        position: "fixed",
        top,
        left,
        width: panelWidth,
        background: "#111827",
        color: "white",
        border: "1px solid #374151",
        borderRadius: 8,
        padding: 12,
        zIndex: 1000000,
        fontFamily: "system-ui, sans-serif",
        boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <strong style={{ fontSize: 12 }}>💬 Ask the agent</strong>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#9CA3AF", cursor: "pointer" }}>
          ✕
        </button>
      </div>
      <textarea
        autoFocus
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="e.g. this is a button, wire it up to the backend"
        rows={3}
        style={{ width: "100%", fontSize: 12, background: "#1F2937", color: "white", border: "1px solid #374151", borderRadius: 4, padding: 6, resize: "vertical" }}
      />
      {error && <div style={{ fontSize: 11, color: "#F87171", marginTop: 6 }}>{error}</div>}
      <button
        onClick={submit}
        disabled={!prompt.trim() || submitting}
        style={{
          marginTop: 8,
          width: "100%",
          fontSize: 12,
          padding: "6px 0",
          borderRadius: 4,
          border: "none",
          background: prompt.trim() && !submitting ? "var(--vle-accent, #9b8ec4)" : "#374151",
          color: "white",
          cursor: prompt.trim() && !submitting ? "pointer" : "default",
        }}
      >
        {submitting ? "Starting…" : "Send to agent"}
      </button>
      <div style={{ fontSize: 10, color: "#6B7280", marginTop: 6 }}>
        Runs in an isolated worktree with full repo access — you'll review a diff before anything touches your live files.
      </div>
    </div>,
    document.body
  );
}
