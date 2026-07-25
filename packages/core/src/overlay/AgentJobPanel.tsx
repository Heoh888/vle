"use client";

import { useState } from "react";
import { createPortal } from "react-dom";

export interface AgentJobView {
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

interface AgentJobPanelProps {
  job: AgentJobView;
  onApply: () => void;
  onDiscard: () => void;
  onPreview: () => void;
  onRefine: (prompt: string) => void;
}

/**
 * Three states, one component: a small badge while the background job runs
 * (polled from VisualEditorOverlay, same pattern as the existing undo/redo
 * status poll), then — once it lands — a floating diff-review panel. Diff
 * is shown, never auto-applied: the whole point of running in an isolated
 * worktree is that a free-form agent might touch more than expected, so
 * Apply is a deliberate, separate step.
 *
 * Once a preview server is up (see agentRunner.ts's startPreview), a
 * Diff/Preview tab toggle appears — showing both a text diff and a full
 * <iframe> at once would make the panel unmanageably tall, so only one is
 * visible at a time. The panel widens only in preview mode; a real page
 * needs more than 420px to be legible.
 */
export function AgentJobPanel({ job, onApply, onDiscard, onPreview, onRefine }: AgentJobPanelProps) {
  const [tab, setTab] = useState<"diff" | "preview">("diff");
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineText, setRefineText] = useState("");

  if (job.status === "running") {
    const elapsedSec = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000));
    return createPortal(
      <div
        style={{
          position: "fixed",
          bottom: 60,
          right: 16,
          zIndex: 999999,
          background: "#111827",
          color: "white",
          borderRadius: 999,
          padding: "8px 14px",
          fontSize: 12,
          fontFamily: "system-ui, sans-serif",
          boxShadow: "0 2px 12px rgba(0,0,0,0.3)",
        }}
      >
        🤖 Agent working… {elapsedSec}s
      </div>,
      document.body
    );
  }

  const showingPreview = tab === "preview" && job.previewStatus;
  const panelWidth = showingPreview ? 900 : 420;

  return createPortal(
    <div
      style={{
        position: "fixed",
        bottom: 60,
        right: 16,
        width: panelWidth,
        // Preview mode needs a firm height, not just a cap — with only
        // maxHeight, a flex column sizes to its content, and the iframe's
        // flex:1 has nothing definite to grow into, so it stayed small.
        // The diff-only view stays content-sized on purpose (a one-line
        // diff shouldn't reserve 80vh of empty space).
        ...(showingPreview ? { height: "85vh" } : { maxHeight: "80vh" }),
        display: "flex",
        flexDirection: "column",
        background: "#111827",
        color: "white",
        border: "1px solid #374151",
        borderRadius: 8,
        zIndex: 999999,
        fontFamily: "system-ui, sans-serif",
        boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: 12, borderBottom: "1px solid #374151" }}>
        <strong style={{ fontSize: 13 }}>{job.status === "done" ? "🤖 Agent finished" : "🤖 Agent error"}</strong>
        <div style={{ fontSize: 10, color: "#6B7280", marginTop: 4, wordBreak: "break-all" }}>
          {job.file} — “{job.prompt}”
        </div>
        {job.status === "done" && (
          <div style={{ fontSize: 10, color: "#6B7280", marginTop: 4 }}>
            {job.diffStat?.trim() ? job.diffStat.trim().split("\n").pop() : "no file changes"}
            {typeof job.costUsd === "number" && ` · $${job.costUsd.toFixed(3)}`}
          </div>
        )}
      </div>

      {job.status === "done" && job.previewStatus && (
        <div style={{ display: "flex", gap: 4, padding: "8px 12px 0" }}>
          {(["diff", "preview"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{ fontSize: 11, padding: "4px 10px", borderRadius: 4, border: "1px solid #374151", background: tab === t ? "#374151" : "transparent", color: "white", cursor: "pointer", textTransform: "capitalize" }}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {job.status === "error" && (
        <div style={{ padding: 12, fontSize: 12, color: "#F87171", overflowY: "auto" }}>{job.error}</div>
      )}

      {job.status === "done" && tab === "diff" && (
        <pre
          style={{
            margin: 0,
            padding: 12,
            fontSize: 11,
            lineHeight: 1.5,
            overflow: "auto",
            flex: 1,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {job.diffText?.trim() || "(no changes)"}
        </pre>
      )}

      {job.status === "done" && tab === "preview" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {job.previewStatus === "starting" && (
            <div style={{ padding: 12, fontSize: 12, color: "#9CA3AF" }}>Starting preview server… (cold start, can take up to ~45s)</div>
          )}
          {job.previewStatus === "error" && (
            <div style={{ padding: 12, fontSize: 12, color: "#F87171" }}>{job.previewError ?? "preview failed"}</div>
          )}
          {job.previewStatus === "ready" && job.previewPort && (
            <>
              <div style={{ padding: "6px 12px", fontSize: 11, borderBottom: "1px solid #374151" }}>
                <a href={`http://127.0.0.1:${job.previewPort}/`} target="_blank" rel="noreferrer" style={{ color: "var(--vle-accent, #9b8ec4)" }}>
                  Open in new tab ↗
                </a>
              </div>
              <iframe
                src={`http://127.0.0.1:${job.previewPort}/`}
                style={{ flex: 1, border: "none", background: "white" }}
                title="Agent preview"
              />
            </>
          )}
        </div>
      )}

      {job.status === "done" && (
        <div style={{ padding: "8px 12px 0" }}>
          {!refineOpen ? (
            <button
              onClick={() => setRefineOpen(true)}
              style={{ width: "100%", fontSize: 11, padding: "5px 0", borderRadius: 4, border: "1px dashed #374151", background: "transparent", color: "#9CA3AF", cursor: "pointer" }}
            >
              ✎ Refine with another instruction
            </button>
          ) : (
            <div style={{ display: "flex", gap: 4 }}>
              <input
                autoFocus
                value={refineText}
                onChange={(e) => setRefineText(e.target.value)}
                placeholder="e.g. make the animation faster"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && refineText.trim()) {
                    onRefine(refineText);
                    setRefineText("");
                    setRefineOpen(false);
                  }
                }}
                style={{ flex: 1, fontSize: 12, background: "#1F2937", color: "white", border: "1px solid #374151", borderRadius: 4, padding: "4px 6px" }}
              />
              <button
                onClick={() => {
                  if (!refineText.trim()) return;
                  onRefine(refineText);
                  setRefineText("");
                  setRefineOpen(false);
                }}
                disabled={!refineText.trim()}
                style={{ fontSize: 11, padding: "4px 10px", borderRadius: 4, border: "none", background: refineText.trim() ? "var(--vle-accent, #9b8ec4)" : "#374151", color: "white", cursor: refineText.trim() ? "pointer" : "default" }}
              >
                Send
              </button>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid #374151" }}>
        {job.status === "done" && job.diffText?.trim() && !job.previewStatus && (
          <button
            onClick={() => {
              onPreview();
              setTab("preview");
            }}
            style={{ flex: 1, fontSize: 12, padding: "6px 0", borderRadius: 4, border: "1px solid #374151", background: "#1F2937", color: "white", cursor: "pointer" }}
          >
            👁 Preview
          </button>
        )}
        {job.status === "done" && job.diffText?.trim() && (
          <button
            onClick={onApply}
            style={{ flex: 1, fontSize: 12, padding: "6px 0", borderRadius: 4, border: "none", background: "var(--vle-accent, #9b8ec4)", color: "white", cursor: "pointer" }}
          >
            Apply
          </button>
        )}
        <button
          onClick={onDiscard}
          style={{ flex: 1, fontSize: 12, padding: "6px 0", borderRadius: 4, border: "1px solid #374151", background: "#1F2937", color: "white", cursor: "pointer" }}
        >
          Discard
        </button>
      </div>
    </div>,
    document.body
  );
}
