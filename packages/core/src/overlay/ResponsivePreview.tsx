"use client";

import { useState } from "react";
import { createPortal } from "react-dom";

interface DevicePreset {
  label: string;
  width: number;
  height: number;
}

const PRESETS: DevicePreset[] = [
  { label: "Mobile", width: 375, height: 667 },
  { label: "Mobile L", width: 414, height: 896 },
  { label: "Tablet", width: 768, height: 1024 },
  { label: "Laptop", width: 1366, height: 800 },
  { label: "Desktop", width: 1920, height: 1080 },
];

/**
 * Loads the *current* page in an <iframe> at a chosen device width, so you
 * can see how elements actually adapt — not a separate rendering path, the
 * same real page/CSS, just constrained to a smaller viewport. Adds
 * ?vle_hide=1 to the iframe's URL so the tool's own toolbar/panels don't
 * clutter what's supposed to be a clean visual check (VisualEditorOverlay
 * checks for this param and renders nothing when present).
 */
export function ResponsivePreview({ onClose }: { onClose: () => void }) {
  const [preset, setPreset] = useState<DevicePreset>(PRESETS[0]);
  const [customWidth, setCustomWidth] = useState<number | null>(null);
  const [rotated, setRotated] = useState(false);

  const baseWidth = customWidth ?? preset.width;
  const baseHeight = customWidth ? Math.round(customWidth * 1.6) : preset.height;
  const width = rotated ? baseHeight : baseWidth;
  const height = rotated ? baseWidth : baseHeight;

  const iframeSrc = (() => {
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.href);
    url.searchParams.set("vle_hide", "1");
    return url.toString();
  })();

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(17, 24, 39, 0.92)",
        zIndex: 1000001,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 12, flexWrap: "wrap", justifyContent: "center" }}>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => {
              setPreset(p);
              setCustomWidth(null);
            }}
            style={{
              fontSize: 12,
              padding: "6px 12px",
              borderRadius: 999,
              border: "1px solid #374151",
              background: !customWidth && preset.label === p.label ? "var(--vle-accent, #9b8ec4)" : "#111827",
              color: "white",
              cursor: "pointer",
            }}
          >
            {p.label} ({p.width}×{p.height})
          </button>
        ))}
        <input
          type="number"
          placeholder="Custom width"
          value={customWidth ?? ""}
          onChange={(e) => setCustomWidth(e.target.value ? Number(e.target.value) : null)}
          style={{ width: 110, fontSize: 12, padding: "6px 8px", borderRadius: 4, border: "1px solid #374151", background: "#1F2937", color: "white" }}
        />
        <button
          onClick={() => setRotated((r) => !r)}
          title="Rotate"
          style={{ fontSize: 12, padding: "6px 10px", borderRadius: 4, border: "1px solid #374151", background: "#111827", color: "white", cursor: "pointer" }}
        >
          ⤾ Rotate
        </button>
        <span style={{ fontSize: 11, color: "#9CA3AF" }}>
          {width} × {height}
        </span>
        <button
          onClick={onClose}
          style={{ fontSize: 12, padding: "6px 12px", borderRadius: 999, border: "none", background: "#450A0A", color: "#FCA5A5", cursor: "pointer" }}
        >
          ✕ Close
        </button>
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto", width: "100%" }}>
        <iframe
          src={iframeSrc}
          style={{
            width,
            height,
            maxWidth: "95vw",
            maxHeight: "85vh",
            border: "8px solid #111827",
            borderRadius: 12,
            background: "white",
            boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
          }}
          title="Responsive preview"
        />
      </div>
    </div>,
    document.body
  );
}
