"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

interface PromoteResult {
  ok: boolean;
  diffText?: string;
  diffStat?: string;
  reason?: string;
}

/**
 * "Promote to main repo" — only rendered when VisualEditorOverlay's /api/vle/meta
 * fetch reports hasMainRepo: true (vle.config.ts's mainRepoRoot is set). See
 * promote.ts: a plain git diff/apply between this checkout (wherever VLE's
 * dev server actually runs — e.g. a dedicated local/* branch's own worktree,
 * see README's "Keeping VLE fully local") and the developer's real checkout.
 * Deliberately not agent-mediated — nothing here is ambiguous enough to need one.
 */
export function PromotePanel({ onClose }: { onClose: () => void }) {
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffStat, setDiffStat] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [open, setOpen] = useState(false);

  const load = () => {
    setError(null);
    setDone(false);
    setDiffText(null);
    fetch("/api/vle/promote")
      .then((res) => res.json())
      .then((result: PromoteResult) => {
        if (result.ok) {
          setDiffText(result.diffText ?? "");
          setDiffStat(result.diffStat);
        } else {
          setError(result.reason ?? "failed to load diff");
        }
      })
      .catch((err) => setError(String(err)));
  };

  useEffect(load, []);

  const promote = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/vle/promote", { method: "POST" });
      const result: PromoteResult = await res.json();
      if (!result.ok) {
        setError(result.reason ?? "promote failed");
        return;
      }
      setDone(true);
      setDiffText("");
    } finally {
      setBusy(false);
    }
  };

  const hasChanges = !!diffText?.trim();

  return createPortal(
    <div
      style={{
        position: "fixed",
        bottom: 60,
        right: 16,
        width: 380,
        maxHeight: "70vh",
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 12, borderBottom: "1px solid #374151" }}>
        <strong style={{ fontSize: 13 }}>⬆ Promote to main repo</strong>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#9CA3AF", cursor: "pointer" }}>
          ✕
        </button>
      </div>

      <div style={{ padding: 12, overflowY: "auto" }}>
        {error && <div style={{ fontSize: 12, color: "#F87171", marginBottom: 8 }}>{error}</div>}

        {done && <div style={{ fontSize: 12, color: "#34D399" }}>Promoted — applied to your main checkout.</div>}

        {!done && diffText === null && !error && <div style={{ fontSize: 12, color: "#6B7280" }}>Loading…</div>}

        {!done && diffText !== null && !hasChanges && !error && (
          <div style={{ fontSize: 12, color: "#6B7280" }}>Nothing to promote right now — this checkout has no uncommitted changes.</div>
        )}

        {!done && hasChanges && (
          <>
            <button
              onClick={() => setOpen((v) => !v)}
              style={{ background: "none", border: "none", color: "#9CA3AF", fontSize: 11, cursor: "pointer", padding: 0, marginBottom: 8, textAlign: "left" }}
            >
              {open ? "▾" : "▸"} {diffStat?.trim() ? diffStat.trim().split("\n").pop() : "changes pending"}
            </button>
            {open && (
              <pre
                style={{
                  margin: "0 0 8px",
                  padding: 8,
                  fontSize: 10,
                  lineHeight: 1.5,
                  maxHeight: 240,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  background: "#1F2937",
                  borderRadius: 4,
                }}
              >
                {diffText}
              </pre>
            )}
            <button
              onClick={promote}
              disabled={busy}
              style={{
                width: "100%",
                fontSize: 12,
                padding: "6px 0",
                borderRadius: 4,
                border: "none",
                background: busy ? "#374151" : "var(--vle-accent, #9b8ec4)",
                color: "white",
                cursor: busy ? "default" : "pointer",
              }}
            >
              {busy ? "Promoting…" : "Promote"}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
