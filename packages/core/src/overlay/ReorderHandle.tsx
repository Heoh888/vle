"use client";

import { useRef, useState } from "react";
import { fileAndIdFor, postPatch, type PatchResponse } from "./patchClient";
import { InsertionLine } from "./InsertionLine";

interface Props {
  el: HTMLElement;
  onPatched: (status: { canUndo: boolean; canRedo: boolean }) => void;
  /** After a successful reorder, HMR reloads the affected module — `el`'s
   * DOM node reference goes stale. Parent should clear selection. */
  onMoved: () => void;
}

interface DropTarget {
  el: HTMLElement;
  position: "before" | "after";
}

/**
 * Grip handle at the top-left of the selection (distinct from the resize
 * handle at bottom-right, see ResizeHandles.tsx — different gesture,
 * shouldn't share a corner). Drop targets are DOM siblings sharing the
 * dragged element's parentElement — a client-side heuristic (DOM structure
 * usually mirrors JSX structure closely enough to pick a target), the
 * *authoritative* check (literal JSX siblings, not a .map()/conditional,
 * same AST parent) happens server-side in patch.ts's applyReorder — this
 * client only needs to narrow down which vleId to send, not be correct on
 * its own.
 */
export function ReorderHandle({ el, onPatched, onMoved }: Props) {
  const [dragging, setDragging] = useState(false);
  const [indicator, setIndicator] = useState<{ top: number; left: number; width: number } | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);

    const parent = el.parentElement;
    const siblings = parent
      ? Array.from(parent.children).filter(
          (c): c is HTMLElement => c instanceof HTMLElement && c !== el && c.hasAttribute("data-vle-id")
        )
      : [];

    const onMove = (ev: PointerEvent) => {
      let best: (DropTarget & { dist: number }) | null = null;
      for (const sib of siblings) {
        const r = sib.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const dist = Math.abs(ev.clientY - mid);
        const position: "before" | "after" = ev.clientY < mid ? "before" : "after";
        if (!best || dist < best.dist) best = { el: sib, position, dist };
      }
      dropTargetRef.current = best;
      if (best) {
        const r = best.el.getBoundingClientRect();
        setIndicator({ top: best.position === "before" ? r.top : r.bottom, left: r.left, width: r.width });
      } else {
        setIndicator(null);
      }
    };

    const onUp = async () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setDragging(false);
      setIndicator(null);
      const target = dropTargetRef.current;
      dropTargetRef.current = null;
      if (!target) return;

      const { file, vleId: draggedVleId } = fileAndIdFor(el);
      const targetVleId = target.el.getAttribute("data-vle-id") ?? "";
      const result: PatchResponse = await postPatch({
        file,
        kind: "reorder",
        draggedVleId,
        targetVleId,
        position: target.position,
      });
      onPatched(result);
      if (result.ok) onMoved();
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const rect = el.getBoundingClientRect();

  return (
    <>
      <div
        onPointerDown={onPointerDown}
        title="Drag to reorder among siblings"
        style={{
          position: "fixed",
          top: rect.top - 10,
          left: rect.left + rect.width / 2 - 9,
          width: 18,
          height: 18,
          borderRadius: 4,
          background: dragging ? "var(--vle-accent, #9b8ec4)" : "#111827",
          border: "1px solid white",
          color: "white",
          fontSize: 11,
          lineHeight: "16px",
          textAlign: "center",
          cursor: "grab",
          zIndex: 999999,
        }}
      >
        ⠿
      </div>
      <InsertionLine indicator={indicator} />
    </>
  );
}
