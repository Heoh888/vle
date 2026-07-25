"use client";

import { useRef, useState, type ReactNode } from "react";
import { fileAndIdFor, postPatch } from "./patchClient";
import { parseGradient, buildGradientCss, parseStopColor, stopColorCss } from "./gradientUtils";
import { FillPanel } from "./FillPanel";
import { FONT_LIBRARY, ensureGoogleFontLoaded } from "./fontLibrary";

interface Props {
  el: HTMLElement;
  /** "tailwind" writes utility classes (the long-established default); "inline" writes real style={{...}} values instead — the only fallback that works regardless of the project's actual CSS methodology, for projects with no Tailwind at all. See VleConfig.stylingMode. */
  stylingMode: "tailwind" | "inline";
  onClose: () => void;
  onPatched: (status: { canUndo: boolean; canRedo: boolean }) => void;
}

/** A CSS property + the value to write for it via an inline-style patch — the fallback every Tailwind-utility-writing control below needs when stylingMode is "inline". */
type InlineEquivalent = { property: string; value: number | string };

type SaveState = { status: "idle" } | { status: "saving" } | { status: "ok" } | { status: "error"; reason: string };

const SECTION_STORAGE_PREFIX = "vle:section:";

// Persisted per section id via localStorage rather than plain useState —
// EditPanel fully remounts on every element selection (see the `key` prop
// in VisualEditorOverlay.tsx), so component-local state would collapse
// every section back to its default each time you click a different
// element, defeating the point of "leave the ones I use open."
function useSectionOpen(id: string, defaultOpen: boolean): [boolean, () => void] {
  const storageKey = SECTION_STORAGE_PREFIX + id;
  const [open, setOpen] = useState(() => {
    if (typeof window === "undefined") return defaultOpen;
    const stored = window.localStorage.getItem(storageKey);
    return stored === null ? defaultOpen : stored === "1";
  });
  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") window.localStorage.setItem(storageKey, next ? "1" : "0");
      return next;
    });
  };
  return [open, toggle];
}

/** Collapsible block wrapper — every top-level group in the panel uses this so the panel doesn't just keep growing as more controls get added. */
function Section({ id, title, defaultOpen = true, topBorder = true, children }: {
  id: string;
  title: string;
  defaultOpen?: boolean;
  topBorder?: boolean;
  children: ReactNode;
}) {
  const [open, toggle] = useSectionOpen(id, defaultOpen);
  return (
    <div style={{ marginBottom: 12, borderTop: topBorder ? "1px solid #374151" : "none", paddingTop: topBorder ? 10 : 0 }}>
      <button
        onClick={toggle}
        style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", background: "none", border: "none", color: "#9CA3AF", fontSize: 11, cursor: "pointer", padding: 0, marginBottom: open ? 8 : 0 }}
      >
        <span>{title}</span>
        <span style={{ fontSize: 9 }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && children}
    </div>
  );
}

/** Extracts the rotation angle (degrees) from a computed transform matrix — was hardcoded to 0, never actually read. */
function currentRotationDeg(transform: string): number {
  if (!transform || transform === "none") return 0;
  const match = transform.match(/matrix\(([^)]+)\)/);
  if (!match) return 0;
  const parts = match[1].split(",").map((s) => parseFloat(s.trim()));
  if (parts.length < 4 || parts.some((n) => Number.isNaN(n))) return 0;
  const [a, b] = parts;
  return Math.round((Math.atan2(b, a) * 180) / Math.PI);
}

/**
 * rgb()/rgba() (what getComputedStyle returns) -> #rrggbb (what
 * <input type="color"> requires) + whether it's actually transparent.
 * <input type="color"> has no way to represent "no color" — it always shows
 * *some* opaque hex, defaulting to black. For an element with no background
 * set at all (rgba(0,0,0,0), the common case), that black swatch looks
 * exactly like "background is black", which it isn't — found live. The
 * label text next to the swatch is what actually carries truth here.
 */
function describeColor(rgb: string): { hex: string; label: string } {
  const nums = rgb.match(/[\d.]+/g);
  if (!nums || nums.length < 3) return { hex: "#000000", label: "unknown" };
  const [r, g, b, a] = nums.map(Number);
  const hex = "#" + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
  if (a === 0) return { hex, label: "none set (transparent) — picker below starts from black" };
  return { hex, label: hex };
}

/**
 * Real color picker, not a swatch of pre-chosen colors — writes as a
 * Tailwind arbitrary value (bg-[#rrggbb]). `initial`/`currentLabel`
 * pre-fill it from the element's actual current color — found live: an
 * <input type="color"> with no `value` set defaults to black in every
 * browser, so this always showed black regardless of the element's real
 * background/text color.
 */
function ColorField({ label, initial, currentLabel, onApply, onClear }: {
  label: string;
  initial: string;
  currentLabel: string;
  onApply: (hex: string) => void;
  onClear: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 11, color: "#9CA3AF" }}>{label}</div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <button
            onClick={onClear}
            title="No color — removes the inline style property if that's what's setting it, otherwise applies *-transparent"
            style={{ fontSize: 10, lineHeight: "18px", width: 20, height: 20, padding: 0, borderRadius: 4, border: "1px solid #374151", background: "#1F2937", color: "#9CA3AF", cursor: "pointer" }}
          >
            ✕
          </button>
          <input
            type="color"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              onApply(e.target.value);
            }}
            style={{ width: 32, height: 22, border: "1px solid #374151", borderRadius: 4, background: "none", cursor: "pointer", padding: 0 }}
          />
        </div>
      </div>
      <div style={{ fontSize: 9, color: "#6B7280", marginTop: 2 }}>current: {currentLabel}</div>
    </div>
  );
}

/**
 * Same as ColorField, plus an opacity slider — <input type="color"> can't
 * represent alpha at all. Keeps hex+alpha together in ONE component's state
 * (not lifted into two separate fields) specifically so adjusting opacity
 * after already having changed hue doesn't reset back to the element's
 * original color — found live with the same split in FillPanel's gradient
 * stops earlier. onApply always receives a single resolved CSS color
 * (stopColorCss: plain hex when fully opaque, rgba(...) otherwise).
 */
function ColorAlphaField({ label, initialHex, initialAlpha, currentLabel, onApply, onClear }: {
  label: string;
  initialHex: string;
  initialAlpha: number;
  currentLabel: string;
  onApply: (cssColor: string) => void;
  onClear: () => void;
}) {
  const [hex, setHex] = useState(initialHex);
  const [alpha, setAlpha] = useState(initialAlpha);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 11, color: "#9CA3AF" }}>{label}</div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <button
            onClick={onClear}
            title="No border"
            style={{ fontSize: 10, lineHeight: "18px", width: 20, height: 20, padding: 0, borderRadius: 4, border: "1px solid #374151", background: "#1F2937", color: "#9CA3AF", cursor: "pointer" }}
          >
            ✕
          </button>
          <input
            type="color"
            value={hex}
            onChange={(e) => {
              setHex(e.target.value);
              onApply(stopColorCss(e.target.value, alpha));
            }}
            style={{ width: 32, height: 22, border: "1px solid #374151", borderRadius: 4, background: "none", cursor: "pointer", padding: 0 }}
          />
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
        <span style={{ fontSize: 9, color: "#6B7280" }}>Opacity</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(alpha * 100)}
          onChange={(e) => {
            const a = Number(e.target.value) / 100;
            setAlpha(a);
            onApply(stopColorCss(hex, a));
          }}
          style={{ flex: 1 }}
        />
        <span style={{ fontSize: 9, color: "#6B7280", width: 28 }}>{Math.round(alpha * 100)}%</span>
      </div>
      <div style={{ fontSize: 9, color: "#6B7280", marginTop: 2 }}>current: {currentLabel}</div>
    </div>
  );
}

/**
 * Swatch button that opens FillPanel — a separate floating window (portaled
 * to document.body, positioned to the left of this panel), not squeezed
 * into this 260px-wide sidebar. Found live: cramming a Photoshop-style
 * draggable gradient bar into that width didn't work — a real design tool's
 * fill picker needs room. This component just tracks its own position
 * (via a ref, read on click) and owns whether the panel is open; FillPanel
 * owns all the actual mode/color/gradient editing state.
 */
function FillTrigger({ label, initialHex, initialColorLabel, initialGradientCss, onApplySolid, onApplyGradient, onClear }: {
  label: string;
  initialHex: string;
  initialColorLabel: string;
  initialGradientCss: string;
  onApplySolid: (hex: string) => void;
  onApplyGradient: (css: string) => void;
  onClear: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const parsedGradient = parseGradient(initialGradientCss);
  const initialMode = parsedGradient ? "gradient" : initialColorLabel.startsWith("none set") ? "none" : "solid";
  const swatchPreview =
    parsedGradient ? buildGradientCss(parsedGradient.type, parsedGradient.angle, parsedGradient.stops)
    : initialMode === "none" ? "repeating-conic-gradient(#374151 0% 25%, #1F2937 0% 50%) 50% / 8px 8px"
    : initialHex;

  return (
    <div style={{ marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ fontSize: 11, color: "#9CA3AF" }}>{label}</div>
      <button
        ref={btnRef}
        onClick={() => {
          if (!open && btnRef.current) setAnchorRect(btnRef.current.getBoundingClientRect());
          setOpen((v) => !v);
        }}
        title="Click to open the fill picker"
        style={{ width: 40, height: 22, border: "1px solid #374151", borderRadius: 4, background: swatchPreview, cursor: "pointer" }}
      />
      {open && anchorRect && (
        <FillPanel
          anchorRect={anchorRect}
          initialMode={initialMode}
          initialHex={initialHex}
          initialGradient={parsedGradient}
          onApplySolid={onApplySolid}
          onApplyGradient={onApplyGradient}
          onClear={onClear}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// align-self/order affect any flex or grid item; justify-self only has any
// effect when the parent is a grid (ignored on flex items per spec) — shown
// conditionally so the panel doesn't offer a control that visibly does
// nothing, which is exactly the kind of clutter this panel deliberately
// avoids elsewhere.
function parentLayoutMode(el: HTMLElement): "flex" | "grid" | null {
  const parent = el.parentElement;
  if (!parent || typeof window === "undefined") return null;
  const display = window.getComputedStyle(parent).display;
  if (display.includes("flex")) return "flex";
  if (display.includes("grid")) return "grid";
  return null;
}

/**
 * align-self/justify-self are enum-valued CSS properties — there's no
 * "type a number" equivalent, so unlike the free-text fields elsewhere a
 * fixed button row here isn't the preset-list clutter that was explicitly
 * rejected earlier; it's the entire valid value space.
 */
function AlignButtons({ label, current, onApply }: {
  label: string;
  current: string;
  onApply: (value: "auto" | "start" | "center" | "end" | "stretch") => void;
}) {
  const options: Array<{ value: "auto" | "start" | "center" | "end" | "stretch"; label: string }> = [
    { value: "auto", label: "Auto" },
    { value: "start", label: "Start" },
    { value: "center", label: "Center" },
    { value: "end", label: "End" },
    { value: "stretch", label: "Stretch" },
  ];
  const isActive = (v: string) => current === v || (v === "start" && current === "flex-start") || (v === "end" && current === "flex-end");
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: "#9CA3AF", marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", gap: 4 }}>
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => onApply(o.value)}
            style={{ flex: 1, fontSize: 10, padding: "3px 0", borderRadius: 4, border: "1px solid #374151", background: isActive(o.value) ? "var(--vle-accent, #9b8ec4)" : "#1F2937", color: "white", cursor: "pointer" }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Same button-row idea as AlignButtons, but for text-align's own value set — kept separate since the options don't overlap (no "auto"/"stretch" for text). */
function TextAlignButtons({ current, onApply }: {
  current: string;
  onApply: (value: "left" | "center" | "right" | "justify") => void;
}) {
  const options: Array<{ value: "left" | "center" | "right" | "justify"; label: string }> = [
    { value: "left", label: "Left" },
    { value: "center", label: "Center" },
    { value: "right", label: "Right" },
    { value: "justify", label: "Justify" },
  ];
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: "#9CA3AF", marginBottom: 4 }}>Align</div>
      <div style={{ display: "flex", gap: 4 }}>
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => onApply(o.value)}
            style={{ flex: 1, fontSize: 10, padding: "3px 0", borderRadius: 4, border: "1px solid #374151", background: current === o.value ? "var(--vle-accent, #9b8ec4)" : "#1F2937", color: "white", cursor: "pointer" }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Same button-row idea as TextAlignButtons, for border-style's value set. "None" doubles as the clear action — a border with style:none doesn't render regardless of width/color, which is a simpler and more useful "off" state than deleting the property outright. */
function BorderStyleButtons({ current, onApply }: {
  current: string;
  onApply: (value: "none" | "solid" | "dashed" | "dotted") => void;
}) {
  const options: Array<{ value: "none" | "solid" | "dashed" | "dotted"; label: string }> = [
    { value: "none", label: "None" },
    { value: "solid", label: "Solid" },
    { value: "dashed", label: "Dashed" },
    { value: "dotted", label: "Dotted" },
  ];
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: "#9CA3AF", marginBottom: 4 }}>Style</div>
      <div style={{ display: "flex", gap: 4 }}>
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => onApply(o.value)}
            style={{ flex: 1, fontSize: 10, padding: "3px 0", borderRadius: 4, border: "1px solid #374151", background: current === o.value ? "var(--vle-accent, #9b8ec4)" : "#1F2937", color: "white", cursor: "pointer" }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A real dropdown of actual fonts (see fontLibrary.ts), not a free-text
 * field — found live: for a property whose valid values are a curated set
 * (not an open value space like a number or hex), every other editor lets
 * you pick from a library instead of typing. Falls back to a "Custom…"
 * text field only when the element's current font doesn't match anything
 * in the library, so an already-custom value isn't silently discarded.
 */
function FontPicker({ label, current, onApply }: {
  label: string;
  current: string;
  onApply: (value: string) => void;
}) {
  const firstFamily = current.split(",")[0]?.replace(/['"]/g, "").trim().toLowerCase() ?? "";
  const matched = FONT_LIBRARY.find((f) => f.value.toLowerCase() === current.trim().toLowerCase() || f.label.toLowerCase() === firstFamily);
  const [customOpen, setCustomOpen] = useState(!matched && current !== "");
  const [customValue, setCustomValue] = useState(current);

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: "#9CA3AF", marginBottom: 4 }}>{label}</div>
      <select
        value={matched ? matched.value : "__custom__"}
        onChange={(e) => {
          if (e.target.value === "__custom__") {
            setCustomOpen(true);
            return;
          }
          setCustomOpen(false);
          const font = FONT_LIBRARY.find((f) => f.value === e.target.value);
          if (font?.googleFont) ensureGoogleFontLoaded(font.googleFont);
          onApply(e.target.value);
        }}
        style={{ width: "100%", fontSize: 12, background: "#1F2937", color: "white", border: "1px solid #374151", borderRadius: 4, padding: "4px 6px" }}
      >
        {FONT_LIBRARY.map((f) => (
          <option key={f.label} value={f.value} style={{ fontFamily: f.value }}>
            {f.label}
          </option>
        ))}
        <option value="__custom__">Custom…</option>
      </select>
      {customOpen && (
        <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
          <input
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            placeholder="'My Font', sans-serif"
            style={{ flex: 1, fontSize: 12, background: "#1F2937", color: "white", border: "1px solid #374151", borderRadius: 4, padding: "3px 6px" }}
          />
          <button
            onClick={() => onApply(customValue)}
            style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, border: "1px solid #374151", background: "#1F2937", color: "white", cursor: "pointer" }}
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}

/** A number you type/edit directly — not a choice among presets. Pre-filled from the element's current computed value where possible. */
function NumberField({ label, unit = "px", initial, onApply }: {
  label: string;
  unit?: string;
  initial: number;
  onApply: (n: number) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div style={{ marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ fontSize: 11, color: "#9CA3AF" }}>{label}</div>
      <div style={{ display: "flex", gap: 4 }}>
        <input
          type="number"
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => setValue(e.target.value === "" ? NaN : Number(e.target.value))}
          style={{ width: 56, fontSize: 12, background: "#1F2937", color: "white", border: "1px solid #374151", borderRadius: 4, padding: "3px 6px" }}
        />
        <button
          onClick={() => onApply(value)}
          disabled={!Number.isFinite(value)}
          style={{
            fontSize: 11,
            padding: "3px 8px",
            borderRadius: 4,
            border: "1px solid #374151",
            background: Number.isFinite(value) ? "#1F2937" : "#111827",
            color: Number.isFinite(value) ? "white" : "#4B5563",
            cursor: Number.isFinite(value) ? "pointer" : "default",
          }}
        >
          {unit === "px" ? "px" : unit}
        </button>
      </div>
    </div>
  );
}

/**
 * No preset buttons anywhere — every control here is an editable field
 * (color picker, number input, text) that writes the exact value you set,
 * not a pick from a fixed list. Common properties (padding, margin, corner
 * radius, font size, colors) get their own always-visible field so you
 * don't have to remember/type a CSS property name for the everyday cases;
 * "Any CSS property" below covers everything else.
 */
export function EditPanel({ el, stylingMode, onClose, onPatched }: Props) {
  const { file, vleId } = fileAndIdFor(el);
  const vleLoc = el.getAttribute("data-vle-loc") ?? "";
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [text, setText] = useState(el.textContent ?? "");
  const [rawClassName, setRawClassName] = useState(el.getAttribute("class") ?? "");
  const [customProp, setCustomProp] = useState("opacity");
  const [customValue, setCustomValue] = useState(1);

  const computed = typeof window !== "undefined" ? window.getComputedStyle(el) : null;
  const currentPx = (prop: string): number => (computed ? Math.round(parseFloat(computed.getPropertyValue(prop)) || 0) : 0);
  const currentColor = (prop: string) => (computed ? describeColor(computed.getPropertyValue(prop)) : { hex: "#000000", label: "unknown" });
  const parentMode = parentLayoutMode(el);

  const setSaving = () => setSave({ status: "saving" });
  const finish = (result: { ok: boolean; reason?: string; canUndo: boolean; canRedo: boolean }) => {
    setSave(result.ok ? { status: "ok" } : { status: "error", reason: result.reason ?? "unknown error" });
    onPatched(result);
  };

  // `inlineEquivalent` is the real CSS property+value the Tailwind class
  // above it means — only used when stylingMode is "inline" (see
  // VleConfig.stylingMode). Optional because a few call sites (bold/
  // italic toggles' underlying values are computed inline at the call
  // site anyway) always pass one; every call site below does.
  const applyClassUtility = async (twValue: string, inlineEquivalent?: InlineEquivalent) => {
    setSaving();
    if (stylingMode === "inline" && inlineEquivalent) {
      finish(await postPatch({ file, vleId, kind: "style", property: inlineEquivalent.property, value: inlineEquivalent.value }));
      return;
    }
    finish(await postPatch({ file, vleId, kind: "className", value: twValue }));
  };

  // A bare "all corners" Tailwind radius class (rounded, rounded-lg,
  // rounded-[8px]…) and a per-corner one (rounded-tl-[8px]…) are DIFFERENT
  // twMerge conflict groups — confirmed live: merging in a new
  // rounded-tl-[N] does NOT drop a pre-existing rounded-[N], both remain in
  // the className. Which one actually wins in the generated CSS then
  // depends on Tailwind's internal plugin registration order, not source
  // order — not safe to rely on. So setting any corner-specific value first
  // strips a bare all-corners class if one's already there.
  const stripAllCornersClass = (className: string): string =>
    className
      .split(/\s+/)
      .filter((c) => !/^rounded(-(none|sm|md|lg|xl|2xl|3xl|full|\[.+\]))?$/.test(c))
      .join(" ");

  const applyCornerRadius = async (corner: "all" | "tl" | "tr" | "br" | "bl", n: number) => {
    setSaving();
    if (stylingMode === "inline") {
      const property =
        corner === "all"
          ? "borderRadius"
          : corner === "tl"
            ? "borderTopLeftRadius"
            : corner === "tr"
              ? "borderTopRightRadius"
              : corner === "br"
                ? "borderBottomRightRadius"
                : "borderBottomLeftRadius";
      finish(await postPatch({ file, vleId, kind: "style", property, value: `${n}px` }));
      return;
    }
    const current = el.getAttribute("class") ?? "";
    const stripped = stripAllCornersClass(current);
    if (stripped !== current) {
      await postPatch({ file, vleId, kind: "className", value: stripped, replace: true });
    }
    const value =
      corner === "all"
        ? `rounded-tl-[${n}px] rounded-tr-[${n}px] rounded-br-[${n}px] rounded-bl-[${n}px]`
        : `rounded-${corner}-[${n}px]`;
    finish(await postPatch({ file, vleId, kind: "className", value }));
  };

  // Same className-vs-style split as resize (ResizeHandles.tsx): if the
  // element's color is actually set via inline style, editing/removing a
  // Tailwind class has zero visual effect — inline style always wins.
  // Found live: PricingSection's "Save 20%" badge sets style={{background:
  // "#9b8ec4"}} — the CSS *shorthand* `background`, not `backgroundColor`.
  // el.style.backgroundColor reads true for EITHER (the browser normalizes
  // the shorthand into it), so that alone can't tell us which property name
  // is literally written in the JSX source — and patch.ts needs the exact
  // literal name to find it. The raw `style` HTML attribute text is what
  // actually reflects the source property name.
  // When stylingMode is "inline", falls back to a sensible default
  // property name (not just null) even if the element doesn't already
  // have an inline color set — on a project with no Tailwind at all,
  // *-[hex] utility classes never render anything, so there's no
  // meaningful "leave it as a class" option to fall back to.
  const inlineColorProp = (cssKind: "background" | "color"): string | null => {
    const raw = el.getAttribute("style") ?? "";
    if (cssKind === "color") {
      if (/(?:^|;)\s*color\s*:/.test(raw)) return "color";
      return stylingMode === "inline" ? "color" : null;
    }
    if (/(?:^|;)\s*background-color\s*:/.test(raw)) return "backgroundColor";
    if (/(?:^|;)\s*background\s*:/.test(raw)) return "background";
    return stylingMode === "inline" ? "backgroundColor" : null;
  };

  const setColor = async (cssKind: "background" | "color", twPrefix: "bg" | "text", hex: string) => {
    setSaving();
    const inlineProp = inlineColorProp(cssKind);
    const result = inlineProp
      ? await postPatch({ file, vleId, kind: "style", property: inlineProp, value: hex })
      : await postPatch({ file, vleId, kind: "className", value: `${twPrefix}-[${hex}]` });
    finish(result);
  };

  const clearColor = async (cssKind: "background" | "color", twPrefix: "bg" | "text") => {
    setSaving();
    const inlineProp = inlineColorProp(cssKind);
    const result = inlineProp
      ? await postPatch({ file, vleId, kind: "styleDelete", property: inlineProp })
      : await postPatch({ file, vleId, kind: "className", value: `${twPrefix}-transparent` });
    finish(result);
  };

  // Same className-vs-inline-style split as background/text color — but
  // border is usually set as ONE shorthand string (style={{border: "1px
  // solid #f3f4f6"}}, found live in HowItWorksSection.tsx's step cards),
  // not separate width/color/style properties. So editing just one of the
  // three means reconstructing the whole shorthand from the other two's
  // current computed values, not splicing a piece out of it. Known
  // simplification: if an element sets ONLY borderColor/borderWidth/
  // borderStyle as separate longhands (no `border` shorthand at all), this
  // still writes a `border` shorthand alongside them — an edge case rare
  // enough not to special-case here.
  const hasInlineBorder = (): boolean => /(?:^|;)\s*border(-width|-color|-style)?\s*:/.test(el.getAttribute("style") ?? "");
  const currentBorderStyleValue = (): "none" | "solid" | "dashed" | "dotted" => {
    const v = computed?.getPropertyValue("border-top-style") ?? "none";
    return v === "solid" || v === "dashed" || v === "dotted" ? v : "none";
  };

  const applyBorder = async (patch: { width?: number; style?: "none" | "solid" | "dashed" | "dotted"; color?: string }) => {
    setSaving();
    if (hasInlineBorder() || stylingMode === "inline") {
      const width = patch.width ?? currentPx("border-top-width");
      const styleVal = patch.style ?? currentBorderStyleValue();
      const color = patch.color ?? currentColor("border-top-color").hex;
      finish(await postPatch({ file, vleId, kind: "style", property: "border", value: `${width}px ${styleVal} ${color}` }));
      return;
    }
    if (patch.width !== undefined) {
      finish(await postPatch({ file, vleId, kind: "className", value: `border-[${patch.width}px]` }));
    } else if (patch.style !== undefined) {
      finish(await postPatch({ file, vleId, kind: "className", value: patch.style === "none" ? "border-none" : `border-${patch.style}` }));
    } else if (patch.color !== undefined) {
      finish(await postPatch({ file, vleId, kind: "className", value: `border-[${patch.color}]` }));
    }
  };

  const applyFontFamily = async (value: string) => {
    setSaving();
    finish(await postPatch({ file, vleId, kind: "style", property: "fontFamily", value }));
  };

  const isBold = computed ? parseInt(computed.fontWeight, 10) >= 600 : false;
  const isItalic = computed?.fontStyle === "italic";
  const toggleBold = () => applyClassUtility(isBold ? "font-normal" : "font-bold", { property: "fontWeight", value: isBold ? 400 : 700 });
  const toggleItalic = () => applyClassUtility(isItalic ? "not-italic" : "italic", { property: "fontStyle", value: isItalic ? "normal" : "italic" });

  const applyGradient = async (value: string) => {
    setSaving();
    // Always the "background" property specifically — matches how gradients
    // already appear in this codebase's own source (style={{background:
    // "linear-gradient(...)"}}), not the backgroundImage longhand.
    finish(await postPatch({ file, vleId, kind: "style", property: "background", value }));
  };

  // Full replace, not a merge — the only way to actually remove a class,
  // not just override a same-category one via twMerge.
  const applyRawClassName = async () => {
    setSaving();
    finish(await postPatch({ file, vleId, kind: "className", value: rawClassName, replace: true }));
  };

  const applyCustomStyle = async () => {
    setSaving();
    finish(await postPatch({ file, vleId, kind: "style", property: customProp, value: customValue }));
  };

  const applyText = async () => {
    setSaving();
    finish(await postPatch({ file, vleId, kind: "text", value: text }));
  };

  // "start"/"end" are valid align-self/justify-self values in modern CSS
  // too, but "flex-start"/"flex-end" matches what getComputedStyle
  // actually returns (and what AlignButtons's isActive() already
  // normalizes toward when reading the CURRENT value) — writing the same
  // form keeps read and write consistent.
  const alignSelfCssValue = (v: "auto" | "start" | "center" | "end" | "stretch"): string =>
    v === "start" ? "flex-start" : v === "end" ? "flex-end" : v;

  const applyDelete = async () => {
    if (!window.confirm("Delete this element? (Cmd+Z / the ↶ button undoes it)")) return;
    setSaving();
    const result = await postPatch({ file, vleId, kind: "delete" });
    finish(result);
    if (result.ok) onClose(); // the element is gone — nothing left to show a panel for
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        width: 260,
        maxHeight: "calc(100vh - 32px)",
        overflowY: "auto",
        background: "#111827",
        color: "white",
        borderRadius: 8,
        padding: 14,
        zIndex: 999999,
        fontFamily: "system-ui, sans-serif",
        boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Visual Editor</strong>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#9CA3AF", cursor: "pointer" }}>
          ✕
        </button>
      </div>
      <div style={{ fontSize: 10, color: "#6B7280", marginBottom: 12, wordBreak: "break-all" }}>{vleLoc}</div>

      <Section id="style" title="Style" topBorder={false} defaultOpen={true}>
        <FillTrigger
          label="Background"
          initialHex={currentColor("background-color").hex}
          initialColorLabel={currentColor("background-color").label}
          initialGradientCss={computed?.backgroundImage && computed.backgroundImage.includes("gradient") ? computed.backgroundImage : ""}
          onApplySolid={(hex) => setColor("background", "bg", hex)}
          onApplyGradient={applyGradient}
          onClear={() => clearColor("background", "bg")}
        />
        <NumberField label="Padding" initial={currentPx("padding-left")} onApply={(n) => applyClassUtility(`p-[${n}px]`, { property: "padding", value: `${n}px` })} />
        <NumberField label="Margin" initial={currentPx("margin-left")} onApply={(n) => applyClassUtility(`m-[${n}px]`, { property: "margin", value: `${n}px` })} />
        <NumberField
          label="Rotation"
          unit="deg"
          initial={computed ? currentRotationDeg(computed.transform) : 0}
          // Inline fallback overwrites `transform` wholesale (rotate-only) —
          // same "known simplification" as the border shorthand below: an
          // element that also translates/scales via inline transform would
          // lose that on a rotation edit. Rare enough not to special-case.
          onApply={(n) => applyClassUtility(`rotate-[${n}deg]`, { property: "transform", value: `rotate(${n}deg)` })}
        />
        {/* Width/Height deliberately not here — see ResizeHandles.tsx: many
            elements (e.g. FeaturesSection cards) size via style={{width}},
            which always wins over a className w-[...] (inline style
            specificity beats a class). Drag the green resize handle
            instead — it detects which one the element actually uses. */}
      </Section>

      <Section id="corner-radius" title="Corner radius" defaultOpen={true}>
        <NumberField label="All corners" initial={currentPx("border-top-left-radius")} onApply={(n) => applyCornerRadius("all", n)} />
        <NumberField label="Top-left" initial={currentPx("border-top-left-radius")} onApply={(n) => applyCornerRadius("tl", n)} />
        <NumberField label="Top-right" initial={currentPx("border-top-right-radius")} onApply={(n) => applyCornerRadius("tr", n)} />
        <NumberField label="Bottom-right" initial={currentPx("border-bottom-right-radius")} onApply={(n) => applyCornerRadius("br", n)} />
        <NumberField label="Bottom-left" initial={currentPx("border-bottom-left-radius")} onApply={(n) => applyCornerRadius("bl", n)} />
      </Section>

      <Section id="border" title="Border" defaultOpen={true}>
        <NumberField label="Width" initial={currentPx("border-top-width")} onApply={(n) => applyBorder({ width: n })} />
        <BorderStyleButtons current={currentBorderStyleValue()} onApply={(v) => applyBorder({ style: v })} />
        <ColorAlphaField
          label="Color"
          initialHex={parseStopColor(computed?.getPropertyValue("border-top-color") ?? "").hex}
          initialAlpha={parseStopColor(computed?.getPropertyValue("border-top-color") ?? "").alpha}
          currentLabel={currentColor("border-top-color").label}
          onApply={(cssColor) => applyBorder({ color: cssColor })}
          onClear={() => applyBorder({ style: "none" })}
        />
      </Section>

      <Section id="text" title="Text" defaultOpen={true}>
        <TextAlignButtons current={computed?.textAlign ?? "left"} onApply={(v) => applyClassUtility(`text-${v}`, { property: "textAlign", value: v })} />
        <FontPicker label="Font family" current={computed?.fontFamily ?? ""} onApply={applyFontFamily} />
        <NumberField label="Font size" initial={currentPx("font-size")} onApply={(n) => applyClassUtility(`text-[${n}px]`, { property: "fontSize", value: `${n}px` })} />
        <NumberField label="Letter spacing" initial={currentPx("letter-spacing")} onApply={(n) => applyClassUtility(`tracking-[${n}px]`, { property: "letterSpacing", value: `${n}px` })} />
        <NumberField label="Line height" initial={currentPx("line-height")} onApply={(n) => applyClassUtility(`leading-[${n}px]`, { property: "lineHeight", value: `${n}px` })} />
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: "#9CA3AF", marginBottom: 4 }}>Style</div>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              onClick={toggleBold}
              style={{ flex: 1, fontWeight: 700, fontSize: 12, padding: "4px 0", borderRadius: 4, border: "1px solid #374151", background: isBold ? "var(--vle-accent, #9b8ec4)" : "#1F2937", color: "white", cursor: "pointer" }}
            >
              B
            </button>
            <button
              onClick={toggleItalic}
              style={{ flex: 1, fontStyle: "italic", fontSize: 12, padding: "4px 0", borderRadius: 4, border: "1px solid #374151", background: isItalic ? "var(--vle-accent, #9b8ec4)" : "#1F2937", color: "white", cursor: "pointer" }}
            >
              I
            </button>
          </div>
        </div>
        <ColorField label="Text color" initial={currentColor("color").hex} currentLabel={currentColor("color").label} onApply={(hex) => setColor("color", "text", hex)} onClear={() => clearColor("color", "text")} />
        <div style={{ fontSize: 11, color: "#9CA3AF", marginBottom: 4 }}>Content</div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          style={{ width: "100%", fontSize: 12, background: "#1F2937", color: "white", border: "1px solid #374151", borderRadius: 4, padding: 6 }}
        />
        <button
          onClick={applyText}
          style={{ marginTop: 6, fontSize: 12, padding: "4px 10px", borderRadius: 4, border: "none", background: "var(--vle-accent, #9b8ec4)", color: "white", cursor: "pointer" }}
        >
          Save text
        </button>
      </Section>

      {parentMode && (
        <Section id="position" title={`Position in parent (${parentMode})`} defaultOpen={false}>
          <AlignButtons label="Align" current={computed?.getPropertyValue("align-self") ?? "auto"} onApply={(v) => applyClassUtility(`self-${v}`, { property: "alignSelf", value: alignSelfCssValue(v) })} />
          {parentMode === "grid" && (
            <AlignButtons label="Justify" current={computed?.getPropertyValue("justify-self") ?? "auto"} onApply={(v) => applyClassUtility(`justify-self-${v}`, { property: "justifySelf", value: alignSelfCssValue(v) })} />
          )}
          <NumberField label="Order" unit="✓" initial={computed ? parseInt(computed.getPropertyValue("order"), 10) || 0 : 0} onApply={(n) => applyClassUtility(`order-[${n}]`, { property: "order", value: n })} />
        </Section>
      )}

      <Section id="classname" title="className" defaultOpen={false}>
        <div style={{ fontSize: 10, color: "#6B7280", marginBottom: 4 }}>Replaces the whole value, not a merge.</div>
        <textarea
          value={rawClassName}
          onChange={(e) => setRawClassName(e.target.value)}
          rows={2}
          style={{ width: "100%", fontSize: 12, fontFamily: "monospace", background: "#1F2937", color: "white", border: "1px solid #374151", borderRadius: 4, padding: 6 }}
        />
        <button
          onClick={applyRawClassName}
          style={{ marginTop: 6, fontSize: 12, padding: "4px 10px", borderRadius: 4, border: "none", background: "var(--vle-accent, #9b8ec4)", color: "white", cursor: "pointer" }}
        >
          Apply className
        </button>
      </Section>

      <Section id="custom-style" title="Any CSS property" defaultOpen={false}>
        <div style={{ fontSize: 10, color: "#6B7280", marginBottom: 4 }}>
          style={"{{"} prop: value {"}}"}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <input
            value={customProp}
            onChange={(e) => setCustomProp(e.target.value)}
            placeholder="opacity"
            style={{ width: 90, fontSize: 12, background: "#1F2937", color: "white", border: "1px solid #374151", borderRadius: 4, padding: "3px 6px" }}
          />
          <input
            type="number"
            value={customValue}
            onChange={(e) => setCustomValue(Number(e.target.value))}
            style={{ width: 60, fontSize: 12, background: "#1F2937", color: "white", border: "1px solid #374151", borderRadius: 4, padding: "3px 6px" }}
          />
          <button
            onClick={applyCustomStyle}
            style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, border: "1px solid #374151", background: "#1F2937", color: "white", cursor: "pointer" }}
          >
            Apply
          </button>
        </div>
        <div style={{ fontSize: 10, color: "#6B7280", marginTop: 4 }}>
          Numeric only (opacity, zIndex, top, letterSpacing…) — string values (colors, "1px solid...") aren't editable here yet.
        </div>
      </Section>

      <Section id="delete" title="Danger zone" defaultOpen={true}>
        <button
          onClick={applyDelete}
          style={{ width: "100%", fontSize: 12, padding: "6px 10px", borderRadius: 4, border: "1px solid #7F1D1D", background: "#450A0A", color: "#FCA5A5", cursor: "pointer" }}
        >
          🗑 Delete element
        </button>
        <div style={{ fontSize: 10, color: "#6B7280", marginTop: 4 }}>
          Refuses on elements rendered via .map()/a conditional — see console/panel message if so.
        </div>
      </Section>

      <div style={{ marginTop: 10, fontSize: 11 }}>
        {save.status === "saving" && <span style={{ color: "#FBBF24" }}>Saving…</span>}
        {save.status === "ok" && <span style={{ color: "#34D399" }}>Saved ✓ (HMR will refresh)</span>}
        {save.status === "error" && (
          <div style={{ color: "#F87171" }}>
            {save.reason}
            {save.reason.includes("may have changed since the page loaded") && (
              <button
                onClick={() => window.location.reload()}
                style={{ display: "block", marginTop: 6, fontSize: 12, padding: "4px 10px", borderRadius: 4, border: "none", background: "var(--vle-accent, #9b8ec4)", color: "white", cursor: "pointer" }}
              >
                Reload page
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
