"use client";

/**
 * Next.js-specific wrapper around the framework-agnostic base overlay —
 * supplies an SSR-safe `hideForPreview` value via next/navigation's
 * useSearchParams() instead of the base's default (window.location.search
 * read directly, which only works for pure client-rendered apps).
 *
 * Found live, the hard way, before this split existed: reading
 * `window.location.search` directly doesn't work under Next.js — `window`
 * is undefined during SSR, so the server-rendered HTML always included the
 * toolbar regardless of the param, and a client-side-only correction
 * wasn't reliably clearing it after hydration (a visible flash, or a
 * hydration-mismatch warning). useSearchParams() is SSR-aware — server and
 * client agree on the very first render, nothing to reconcile.
 *
 * Also found live: the query param alone only covers the page a
 * ResponsivePreview iframe actually loaded — clicking a link inside that
 * iframe does a client-side Next.js navigation to a new route, which drops
 * the query string, so the toolbar reappeared on every page but the
 * first. `window.self !== window.top` survives that: it's true for as
 * long as this is rendered inside ANY iframe, regardless of route. Kept
 * alongside the query-param check (not a replacement for it) — the query
 * param is what's authoritative on first load, before hydration has had a
 * chance to evaluate window.self at all.
 */
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { VisualEditorOverlay as BaseVisualEditorOverlay, type VisualEditorOverlayProps } from "../VisualEditorOverlay";

type NextVisualEditorOverlayProps = Omit<VisualEditorOverlayProps, "hideForPreview">;

function Inner(props: NextVisualEditorOverlayProps) {
  const searchParams = useSearchParams();
  const hideForPreview = searchParams.get("vle_hide") === "1" || (typeof window !== "undefined" && window.self !== window.top);
  return <BaseVisualEditorOverlay {...props} hideForPreview={hideForPreview} />;
}

/** Drop-in replacement for the base VisualEditorOverlay, for Next.js App Router projects. Wrapped in Suspense because useSearchParams() requires it. */
export function VisualEditorOverlay(props: NextVisualEditorOverlayProps = {}) {
  return (
    <Suspense fallback={null}>
      <Inner {...props} />
    </Suspense>
  );
}
