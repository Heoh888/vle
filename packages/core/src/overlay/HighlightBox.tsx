"use client";

import { useEffect, useState } from "react";

interface Props {
  el: HTMLElement | null;
  color: string;
  label?: string;
}

/** Fixed-position outline tracking an element's bounding box, via a rAF loop — simplest way to stay correct across arbitrary scroll containers without wiring up per-ancestor scroll listeners. */
export function HighlightBox({ el, color, label }: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!el) {
      setRect(null);
      return;
    }
    let raf = 0;
    const tick = () => {
      setRect(el.getBoundingClientRect());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [el]);

  if (!rect) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        border: `2px solid ${color}`,
        pointerEvents: "none",
        zIndex: 999998,
        boxSizing: "border-box",
      }}
    >
      {label && (
        <span
          style={{
            position: "absolute",
            top: -20,
            left: 0,
            background: color,
            color: "white",
            fontSize: 11,
            fontFamily: "monospace",
            padding: "1px 6px",
            borderRadius: 3,
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}
