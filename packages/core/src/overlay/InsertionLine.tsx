"use client";

export interface InsertionIndicator {
  top: number;
  left: number;
  width: number;
}

/**
 * Thin horizontal line marking where a dragged element will land — shared
 * by ReorderHandle (moving an existing element among its siblings) and the
 * design-system palette's drag-and-drop (inserting a brand-new one
 * anywhere on the page). Extracted here once a second caller needed it.
 */
export function InsertionLine({ indicator }: { indicator: InsertionIndicator | null }) {
  if (!indicator) return null;
  return (
    <div
      style={{
        position: "fixed",
        top: indicator.top - 1,
        left: indicator.left,
        width: indicator.width,
        height: 2,
        background: "var(--vle-accent, #9b8ec4)",
        zIndex: 999999,
        pointerEvents: "none",
      }}
    />
  );
}
