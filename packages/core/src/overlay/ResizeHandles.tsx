"use client";

import { useEffect, useRef, useState } from "react";
import { fileAndIdFor, postPatch, type PatchResponse } from "./patchClient";

interface Props {
  el: HTMLElement;
  onPatched: (status: { canUndo: boolean; canRedo: boolean }) => void;
}

/**
 * Single bottom-right handle only, on purpose — resizing keeps the
 * element's top-left corner fixed and only changes width/height, never
 * top/left. Corner handles that grow "outward" (top-left, top-right, ...)
 * would need to also shift position to look right, and that's exactly the
 * free-positioning territory the plan ruled out (would fight flex/grid
 * layout instead of just changing one element's own size).
 */
export function ResizeHandles({ el, onPatched }: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [saving, setSaving] = useState(false);
  const dragState = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setRect(el.getBoundingClientRect());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [el]);

  const commitDimension = async (property: "width" | "height", pxValue: number) => {
    const { file, vleId } = fileAndIdFor(el);
    // If the element already has this dimension via inline style, patch that
    // — otherwise assume/add a Tailwind arbitrary-value class. Checking
    // el.style (the live inline style, not getComputedStyle) tells us which
    // one is actually authoritative in source, not just what layout produced.
    const usesInlineStyle = !!(property === "width" ? el.style.width : el.style.height);
    const body = usesInlineStyle
      ? { file, vleId, kind: "style" as const, property, value: Math.round(pxValue) }
      : { file, vleId, kind: "className" as const, value: `${property === "width" ? "w" : "h"}-[${Math.round(pxValue)}px]` };
    return postPatch(body);
  };

  const onHandlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    dragState.current = { startX: e.clientX, startY: e.clientY, startW: r.width, startH: r.height };

    const onMove = (ev: PointerEvent) => {
      if (!dragState.current) return;
      const dx = ev.clientX - dragState.current.startX;
      const dy = ev.clientY - dragState.current.startY;
      // Live preview only — temporary, gets replaced by whatever the saved
      // source actually renders as once HMR reloads the component.
      el.style.width = `${Math.max(8, dragState.current.startW + dx)}px`;
      el.style.height = `${Math.max(8, dragState.current.startH + dy)}px`;
    };

    const onUp = async (ev: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      if (!dragState.current) return;
      const dx = ev.clientX - dragState.current.startX;
      const dy = ev.clientY - dragState.current.startY;
      const newW = Math.max(8, dragState.current.startW + dx);
      const newH = Math.max(8, dragState.current.startH + dy);
      dragState.current = null;

      setSaving(true);
      const results: PatchResponse[] = [];
      if (Math.abs(dx) > 1) results.push(await commitDimension("width", newW));
      if (Math.abs(dy) > 1) results.push(await commitDimension("height", newH));
      setSaving(false);

      const last = results[results.length - 1];
      if (last) onPatched(last);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  if (!rect) return null;

  const handleStyle: React.CSSProperties = {
    position: "fixed",
    width: 10,
    height: 10,
    background: "#34D399",
    border: "1px solid white",
    borderRadius: 2,
    zIndex: 999999,
    cursor: "nwse-resize",
    left: rect.right - 5,
    top: rect.bottom - 5,
    opacity: saving ? 0.5 : 1,
  };

  return <div style={handleStyle} onPointerDown={onHandlePointerDown} title="Drag to resize (width/height only)" />;
}
