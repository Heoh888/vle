"use client";

import { useCallback, useEffect, useState } from "react";

/** Walks up from an event target to the nearest element carrying data-vle-id. */
function findTaggedAncestor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>("[data-vle-id]");
}

export interface UseInspectorResult {
  inspecting: boolean;
  toggleInspecting: () => void;
  hoveredEl: HTMLElement | null;
  selectedEl: HTMLElement | null;
  selectElement: (el: HTMLElement | null) => void;
}

/** Hover-to-highlight, click-to-select, over any element tagged by the babel-loader. */
export function useInspector(): UseInspectorResult {
  const [inspecting, setInspecting] = useState(false);
  const [hoveredEl, setHoveredEl] = useState<HTMLElement | null>(null);
  const [selectedEl, setSelectedEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!inspecting) {
      setHoveredEl(null);
      return;
    }

    const onMove = (e: MouseEvent) => setHoveredEl(findTaggedAncestor(e.target));
    const onClick = (e: MouseEvent) => {
      const el = findTaggedAncestor(e.target);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      setSelectedEl(el);
      setInspecting(false);
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [inspecting]);

  const toggleInspecting = useCallback(() => setInspecting((v) => !v), []);
  const selectElement = useCallback((el: HTMLElement | null) => setSelectedEl(el), []);

  return { inspecting, toggleInspecting, hoveredEl, selectedEl, selectElement };
}
