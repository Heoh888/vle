export interface GradientStop {
  color: string; // always #rrggbb — <input type="color"> requires it, alpha is tracked separately
  alpha: number; // 0-1
  position: number; // 0-100
}

/** Best-effort: rgb()/rgba()/#hex/#hexa/transparent/named -> {hex, alpha}, for a gradient stop's color + opacity controls. */
export function parseStopColor(color: string): { hex: string; alpha: number } {
  const trimmed = color.trim();
  if (/^transparent$/i.test(trimmed)) return { hex: "#ffffff", alpha: 0 };

  if (trimmed.startsWith("#") && (trimmed.length === 7 || trimmed.length === 4)) {
    return { hex: trimmed.length === 4 ? "#" + trimmed.slice(1).split("").map((c) => c + c).join("") : trimmed, alpha: 1 };
  }
  if (trimmed.startsWith("#") && (trimmed.length === 9 || trimmed.length === 5)) {
    const full = trimmed.length === 5 ? trimmed.slice(1).split("").map((c) => c + c).join("") : trimmed.slice(1);
    return { hex: "#" + full.slice(0, 6), alpha: parseInt(full.slice(6, 8), 16) / 255 };
  }

  const nums = trimmed.match(/[\d.]+/g);
  if (nums && nums.length >= 3) {
    const [r, g, b] = nums.slice(0, 3).map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))));
    const alpha = nums.length >= 4 ? Math.max(0, Math.min(1, Number(nums[3]))) : 1;
    return { hex: "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join(""), alpha };
  }
  return { hex: "#ffffff", alpha: 1 };
}

/** #rrggbb + 0-1 alpha -> a CSS color the browser accepts directly (skips rgba() math when fully opaque, since the plain hex round-trips cleaner through patch.ts's string splice). */
export function stopColorCss(hex: string, alpha: number): string {
  if (alpha >= 1) return hex;
  const nums = hex.match(/[0-9a-f]{2}/gi);
  if (!nums || nums.length < 3) return hex;
  const [r, g, b] = nums.map((h) => parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 100) / 100})`;
}

/** Splits a gradient's inner content on top-level commas only — rgba(a, b, c, d) has commas that aren't stop separators. */
export function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// getComputedStyle preserves keyword directions as-is (e.g. Tailwind's
// bg-gradient-to-b resolves to "linear-gradient(to bottom, ...)") — it does
// NOT normalize them to "180deg". Without this map, a keyword direction fell
// through and got parsed as if it were the first color stop, producing a
// fake white stop and wrong positions for every real stop after it.
const DIRECTION_TO_DEG: Record<string, number> = {
  "to top": 0,
  "to top right": 45,
  "to right top": 45,
  "to right": 90,
  "to bottom right": 135,
  "to right bottom": 135,
  "to bottom": 180,
  "to bottom left": 225,
  "to left bottom": 225,
  "to left": 270,
  "to left top": 315,
  "to top left": 315,
};

// A radial-gradient's shape/size/position descriptor ("ellipse 90% 70% at
// 50% 10%", "circle at center", or just "90% 70% at 50% 10%" — Chrome drops
// the "ellipse" keyword entirely since it's the default shape, so checking
// for the literal words "circle"/"ellipse" isn't reliable) has no fixed
// keyword to key off of. What's reliable is that a real color stop always
// *starts* with a color. Anything before the first real color stop, if
// present, is the descriptor and gets skipped.
function isColorStopStart(part: string): boolean {
  return /^(#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|transparent\b|currentcolor\b)/i.test(part.trim());
}

/** Parses a computed linear-/radial-gradient(...) string back into editable stops — best-effort starting point, not a full CSS parser. */
export function parseGradient(css: string): { type: "linear" | "radial"; angle: number; stops: GradientStop[] } | null {
  const isLinear = css.startsWith("linear-gradient(");
  const isRadial = css.startsWith("radial-gradient(");
  if (!isLinear && !isRadial) return null;

  const inner = css.slice(css.indexOf("(") + 1, css.lastIndexOf(")"));
  const parts = splitTopLevel(inner);
  if (parts.length === 0) return null;

  let angle = 180;
  let stopParts = parts;
  if (isLinear && /deg$/.test(parts[0])) {
    angle = parseFloat(parts[0]);
    stopParts = parts.slice(1);
  } else if (isLinear && parts[0].startsWith("to ")) {
    angle = DIRECTION_TO_DEG[parts[0]] ?? 180;
    stopParts = parts.slice(1);
  } else if (isRadial && !isColorStopStart(parts[0])) {
    stopParts = parts.slice(1);
  }

  const stops: GradientStop[] = stopParts.map((p, i) => {
    const m = p.match(/^(.+?)\s+([\d.]+)%$/);
    const colorPart = m ? m[1] : p;
    const position = m ? parseFloat(m[2]) : stopParts.length > 1 ? (i / (stopParts.length - 1)) * 100 : 0;
    const { hex, alpha } = parseStopColor(colorPart.trim());
    return { color: hex, alpha, position };
  });

  if (stops.length < 2) return null;
  return { type: isLinear ? "linear" : "radial", angle, stops };
}

export function buildGradientCss(type: "linear" | "radial", angle: number, stops: GradientStop[]): string {
  const stopsCss = [...stops]
    .sort((a, b) => a.position - b.position)
    .map((s) => `${stopColorCss(s.color, s.alpha)} ${s.position}%`)
    .join(", ");
  return type === "linear" ? `linear-gradient(${angle}deg, ${stopsCss})` : `radial-gradient(circle, ${stopsCss})`;
}
