"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type GradientStop, buildGradientCss, stopColorCss } from "./gradientUtils";

/**
 * Photoshop-style gradient bar: stops are small squares sitting under the
 * bar, colored to match their own stop. Click empty bar space to add a new
 * stop there (color cloned from the nearest existing stop). Drag a stop
 * left/right to reposition — no typing a percentage required, though the
 * exact number is still shown/editable below for precision.
 */
function GradientBar({ type, angle, stops, selectedIndex, onSelect, onChangeStops }: {
  type: "linear" | "radial";
  angle: number;
  stops: GradientStop[];
  selectedIndex: number;
  onSelect: (i: number) => void;
  onChangeStops: (stops: GradientStop[]) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const preview = buildGradientCss(type, angle, stops);

  const positionFromClientX = (clientX: number): number => {
    const rect = barRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(100, Math.round(((clientX - rect.left) / rect.width) * 100)));
  };

  const onBarClick = (e: React.MouseEvent) => {
    const position = positionFromClientX(e.clientX);
    const nearest = [...stops].sort((a, b) => Math.abs(a.position - position) - Math.abs(b.position - position))[0];
    const next = [...stops, { color: nearest?.color ?? "#ffffff", alpha: nearest?.alpha ?? 1, position }];
    onChangeStops(next);
    onSelect(next.length - 1);
  };

  const onMarkerPointerDown = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect(i);
    const onMove = (ev: PointerEvent) => {
      const position = positionFromClientX(ev.clientX);
      onChangeStops(stops.map((s, idx) => (idx === i ? { ...s, position } : s)));
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  return (
    <div
      ref={barRef}
      onClick={onBarClick}
      title="Click to add a stop here, drag a stop to move it"
      style={{ position: "relative", height: 32, borderRadius: 4, border: "1px solid #374151", background: preview, cursor: "copy", marginBottom: 16 }}
    >
      {stops.map((stop, i) => (
        <div
          key={i}
          onPointerDown={onMarkerPointerDown(i)}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            left: `${stop.position}%`,
            top: "100%",
            marginTop: 4,
            transform: "translateX(-50%)",
            width: 14,
            height: 14,
            borderRadius: 3,
            backgroundImage: `linear-gradient(${stopColorCss(stop.color, stop.alpha)}, ${stopColorCss(stop.color, stop.alpha)}), repeating-conic-gradient(#374151 0% 25%, #1F2937 0% 50%)`,
            backgroundSize: "100% 100%, 6px 6px",
            border: selectedIndex === i ? "2px solid white" : "1px solid #374151",
            boxShadow: selectedIndex === i ? "0 0 0 2px var(--vle-accent, #9b8ec4)" : "none",
            cursor: "grab",
          }}
        />
      ))}
    </div>
  );
}

interface FillPanelProps {
  anchorRect: DOMRect;
  initialMode: "solid" | "gradient" | "none";
  initialHex: string;
  initialGradient: { type: "linear" | "radial"; angle: number; stops: GradientStop[] } | null;
  onApplySolid: (hex: string) => void;
  onApplyGradient: (css: string) => void;
  onClear: () => void;
  onClose: () => void;
}

/**
 * Separate floating window (portaled to document.body — escapes EditPanel's
 * overflow:auto clipping and its 260px width constraint) rather than an
 * inline popover squeezed into the sidebar. Positioned to the left of
 * EditPanel. Modeled on Photoshop's Gradient Editor: a real draggable bar,
 * not disconnected number fields.
 */
export function FillPanel({ anchorRect, initialMode, initialHex, initialGradient, onApplySolid, onApplyGradient, onClear, onClose }: FillPanelProps) {
  const [mode, setMode] = useState(initialMode);
  const [solidHex, setSolidHex] = useState(initialHex);
  const [type, setType] = useState<"linear" | "radial">(initialGradient?.type ?? "linear");
  const [angle, setAngle] = useState(initialGradient?.angle ?? 180);
  const [stops, setStops] = useState<GradientStop[]>(
    initialGradient?.stops ?? [
      { color: "var(--vle-accent, #9b8ec4)", alpha: 1, position: 0 },
      { color: "#ffffff", alpha: 1, position: 100 },
    ]
  );
  const [selected, setSelected] = useState(0);

  const updateSelectedStop = (patch: Partial<GradientStop>) =>
    setStops((prev) => prev.map((s, i) => (i === selected ? { ...s, ...patch } : s)));

  const removeSelectedStop = () => {
    if (stops.length <= 2) return;
    const next = stops.filter((_, i) => i !== selected);
    setStops(next);
    setSelected(Math.max(0, selected - 1));
  };

  const panelWidth = 300;

  return createPortal(
    <div
      style={{
        position: "fixed",
        top: anchorRect.top,
        left: Math.max(8, anchorRect.left - panelWidth - 12),
        width: panelWidth,
        background: "#111827",
        color: "white",
        border: "1px solid #374151",
        borderRadius: 8,
        padding: 14,
        zIndex: 1000000,
        fontFamily: "system-ui, sans-serif",
        boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <strong style={{ fontSize: 12 }}>Fill</strong>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#9CA3AF", cursor: "pointer" }}>
          ✕
        </button>
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        {(["solid", "gradient", "none"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              if (m === "none") onClear();
            }}
            style={{ flex: 1, fontSize: 11, padding: "4px 0", borderRadius: 4, border: "1px solid #374151", background: mode === m ? "var(--vle-accent, #9b8ec4)" : "#1F2937", color: "white", cursor: "pointer", textTransform: "capitalize" }}
          >
            {m}
          </button>
        ))}
      </div>

      {mode === "solid" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input
            type="color"
            value={solidHex}
            onChange={(e) => {
              setSolidHex(e.target.value);
              onApplySolid(e.target.value);
            }}
            style={{ width: 60, height: 40, border: "1px solid #374151", borderRadius: 4, background: "none", cursor: "pointer", padding: 0 }}
          />
          <span style={{ fontSize: 12, color: "#9CA3AF", fontFamily: "monospace" }}>{solidHex}</span>
        </div>
      )}

      {mode === "gradient" && (
        <div>
          <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
            <button
              onClick={() => setType("linear")}
              style={{ flex: 1, fontSize: 11, padding: "4px 0", borderRadius: 4, border: "1px solid #374151", background: type === "linear" ? "#374151" : "#1F2937", color: "white", cursor: "pointer" }}
            >
              Linear
            </button>
            <button
              onClick={() => setType("radial")}
              style={{ flex: 1, fontSize: 11, padding: "4px 0", borderRadius: 4, border: "1px solid #374151", background: type === "radial" ? "#374151" : "#1F2937", color: "white", cursor: "pointer" }}
            >
              Radial
            </button>
          </div>

          {type === "linear" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 11, color: "#9CA3AF" }}>Angle</span>
              <input type="range" min={0} max={360} value={angle} onChange={(e) => setAngle(Number(e.target.value))} style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: "#9CA3AF", width: 32 }}>{angle}°</span>
            </div>
          )}

          <GradientBar type={type} angle={angle} stops={stops} selectedIndex={selected} onSelect={setSelected} onChangeStops={setStops} />

          {stops[selected] && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <input
                  type="color"
                  value={stops[selected].color}
                  onChange={(e) => updateSelectedStop({ color: e.target.value })}
                  style={{ width: 28, height: 22, border: "1px solid #374151", borderRadius: 4, background: "none", cursor: "pointer", padding: 0 }}
                />
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={stops[selected].position}
                  onChange={(e) => updateSelectedStop({ position: Math.max(0, Math.min(100, Number(e.target.value))) })}
                  style={{ width: 50, fontSize: 11, background: "#1F2937", color: "white", border: "1px solid #374151", borderRadius: 4, padding: "3px 6px" }}
                />
                <span style={{ fontSize: 10, color: "#6B7280" }}>%</span>
                <button
                  onClick={removeSelectedStop}
                  disabled={stops.length <= 2}
                  style={{ marginLeft: "auto", fontSize: 10, padding: "3px 8px", borderRadius: 4, border: "1px solid #374151", background: "#1F2937", color: stops.length <= 2 ? "#4B5563" : "#F87171", cursor: stops.length <= 2 ? "default" : "pointer" }}
                >
                  Delete stop
                </button>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 11, color: "#9CA3AF" }}>Opacity</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(stops[selected].alpha * 100)}
                  onChange={(e) => updateSelectedStop({ alpha: Number(e.target.value) / 100 })}
                  style={{ flex: 1 }}
                />
                <span style={{ fontSize: 11, color: "#9CA3AF", width: 32 }}>{Math.round(stops[selected].alpha * 100)}%</span>
              </div>
            </>
          )}

          <button
            onClick={() => onApplyGradient(buildGradientCss(type, angle, stops))}
            style={{ width: "100%", fontSize: 12, padding: "6px 0", borderRadius: 4, border: "none", background: "var(--vle-accent, #9b8ec4)", color: "white", cursor: "pointer" }}
          >
            Apply gradient
          </button>
        </div>
      )}

      {mode === "none" && <div style={{ fontSize: 11, color: "#6B7280" }}>No fill — applied immediately.</div>}
    </div>,
    document.body
  );
}
