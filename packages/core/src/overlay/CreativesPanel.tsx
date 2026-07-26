"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export interface CreativeAsset {
  name: string;
  type: "image" | "video" | "other";
  size: number;
  mtimeMs: number;
}

export interface DraggedCreativePayload {
  name: string;
  tag: "img" | "video";
}

/** Distinct from VLE_COMPONENT_DND_MIME so VisualEditorOverlay's document-level drop handler can tell a creative tile apart from a design-system component — they need different server-side handling (copy-then-insert vs plain insert). */
export const VLE_CREATIVE_DND_MIME = "application/x-vle-creative";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface CreativesPanelProps {
  onClose: () => void;
}

/**
 * Floating palette of generated (or manually dropped) creative assets —
 * see creativesScan.ts. Unlike DesignSystemPanel's live component
 * previews, these are just static files, so a plain <img>/<video> pointed
 * at the raw-serve endpoint is enough — no dynamic-import machinery
 * needed here.
 *
 * Dragging a tile onto the page doesn't insert it directly: the drop
 * handler in VisualEditorOverlay.tsx posts to /api/vle/creatives/insert,
 * which copies the file into publicDir first (so the JSX ends up
 * referencing a real, permanent static asset, not this dev-only endpoint)
 * and only then splices in the <img>/<video> tag — same reasoning as why
 * the design-system palette's drop handler talks to a dedicated endpoint
 * rather than the plain patch one.
 */
export function CreativesPanel({ onClose }: CreativesPanelProps) {
  const [assets, setAssets] = useState<CreativeAsset[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAssets = () => {
    fetch("/api/vle/creatives")
      .then((res) => res.json())
      .then((result) => {
        if (result.ok) setAssets(result.assets);
        else setError(result.reason ?? "failed to load creatives");
      })
      .catch((err) => setError(String(err)));
  };

  useEffect(loadAssets, []);

  const onDragStart = (a: CreativeAsset) => (e: React.DragEvent) => {
    if (a.type === "other") {
      e.preventDefault();
      return;
    }
    const payload: DraggedCreativePayload = { name: a.name, tag: a.type === "video" ? "video" : "img" };
    e.dataTransfer.setData(VLE_CREATIVE_DND_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "copy";
  };

  return createPortal(
    <div
      style={{
        position: "fixed",
        top: 16,
        left: 420,
        width: 260,
        maxHeight: "calc(100vh - 32px)",
        overflowY: "auto",
        background: "#111827",
        color: "white",
        border: "1px solid #374151",
        borderRadius: 8,
        padding: 14,
        zIndex: 999998,
        fontFamily: "system-ui, sans-serif",
        boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <strong style={{ fontSize: 13 }}>🎨 Creatives</strong>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={loadAssets}
            title="Refresh"
            style={{ background: "none", border: "none", color: "#9CA3AF", cursor: "pointer", fontSize: 12 }}
          >
            ⟳
          </button>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#9CA3AF", cursor: "pointer" }}>
            ✕
          </button>
        </div>
      </div>
      <div style={{ fontSize: 10, color: "#6B7280", marginBottom: 10 }}>
        Drag onto the page to insert. Ask an agent (Comment or Chat) to generate something if you have an image/video MCP tool connected.
      </div>

      {error && <div style={{ fontSize: 12, color: "#F87171" }}>{error}</div>}
      {!assets && !error && <div style={{ fontSize: 12, color: "#6B7280" }}>Loading…</div>}
      {assets && assets.length === 0 && !error && (
        <div style={{ fontSize: 11, color: "#6B7280", lineHeight: 1.5 }}>
          Nothing here yet. Try asking an agent something like "generate a hero background image" — if you have a
          creative-generation MCP tool connected, it'll land here once it's done.
        </div>
      )}

      {assets?.map((a) => (
        <div
          key={a.name}
          draggable={a.type !== "other"}
          onDragStart={onDragStart(a)}
          title={a.name}
          style={{
            marginBottom: 8,
            borderRadius: 6,
            overflow: "hidden",
            border: "1px solid #374151",
            cursor: a.type === "other" ? "default" : "grab",
          }}
        >
          <div
            style={{
              background: "repeating-conic-gradient(#1F2937 0% 25%, #111827 0% 50%)",
              backgroundSize: "16px 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 90,
              maxHeight: 140,
              overflow: "hidden",
            }}
          >
            {a.type === "image" && (
              <img src={`/api/vle/creatives/file?name=${encodeURIComponent(a.name)}`} alt={a.name} style={{ maxWidth: "100%", maxHeight: 140, objectFit: "contain" }} />
            )}
            {a.type === "video" && (
              <video src={`/api/vle/creatives/file?name=${encodeURIComponent(a.name)}`} muted style={{ maxWidth: "100%", maxHeight: 140 }} />
            )}
            {a.type === "other" && <span style={{ fontSize: 11, color: "#6B7280" }}>Unsupported file</span>}
          </div>
          <div style={{ background: "#1F2937", padding: "6px 10px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
            <div style={{ fontSize: 9, color: "#6B7280", marginTop: 2 }}>{formatSize(a.size)}</div>
          </div>
        </div>
      ))}
    </div>,
    document.body
  );
}
