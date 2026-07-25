"use client";

import { Component, Suspense, lazy, useEffect, useMemo, useState, type ReactNode, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { type ChatView } from "./ChatPanel";

const GENERATE_POLL_MS = 3000;

const DEFAULT_GENERATE_PROMPT =
  `Analyze the whole app (every page and component) for the visual language actually in use — real colors (prefer matching tailwind.config's existing theme palette if there is one), spacing scale, typography, border-radius, shadows, and any button/card/badge/input patterns already duplicated ad-hoc across the codebase. Create a cohesive, professional component library in components/ui-kit/ (create this folder if it doesn't exist yet — do not modify the existing components/ui/). Follow the exact same architectural pattern as components/ui/ if one exists (TS prop interfaces with sensible optional defaults, JSDoc above each component, plain/simple className construction so it stays editable via the visual tool). Create/update components/ui-kit/index.ts to export each one the same way components/ui/index.ts does (export { default as Name } from "./Name";). Cover pieces you find real evidence for — don't invent patterns not grounded in the actual app.`;

export interface DesignSystemComponent {
  name: string;
  dir: string;
  hasChildren: boolean;
  description?: string;
}

export interface DraggedComponentPayload {
  name: string;
  elementSnippet: string;
  importName: string;
  importFrom: string;
}

/** Custom MIME type for the drag payload — kept distinct from "text/plain" etc so VisualEditorOverlay's document-level drop handler can tell "a design-system tile" apart from any other drag a user might do on the page. */
export const VLE_COMPONENT_DND_MIME = "application/x-vle-component";

/**
 * Two separate, statically-prefixed dynamic imports rather than one
 * `import(\`@/${dir}/${name}\`)` — webpack builds a "context module" per
 * distinct static prefix it can see at build time; a fully dynamic prefix
 * would force it to context-bundle the entire frontend/ tree behind the
 * "@/" alias instead of just these two known, narrow folders.
 */
function importComponent(dir: string, name: string): Promise<{ default: ComponentType<any> }> {
  if (dir === "components/ui-kit") return import(`@/components/ui-kit/${name}`);
  return import(`@/components/ui/${name}`);
}

/** Catches a render-time throw from a live preview (e.g. an agent-generated component that turns out to need a required prop with no default) — React.lazy's Suspense only covers the *loading* state, not render errors, which need an actual error boundary. */
class PreviewErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch() {
    // Swallow — the fallback card already communicates "couldn't preview this", no need for noisy console output in a dev tool.
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

function ComponentPreview({ dir, name, hasChildren }: { dir: string; name: string; hasChildren: boolean }) {
  const Lazy = useMemo(() => lazy(() => importComponent(dir, name)), [dir, name]);
  return <Lazy>{hasChildren ? name : undefined}</Lazy>;
}

interface DesignSystemPanelProps {
  onClose: () => void;
}

/**
 * Floating palette of the site's reusable components (see
 * designSystemScan.ts — auto-scanned from components/ui/ and, once
 * generated, components/ui-kit/ — not manually curated). Each tile renders
 * a REAL live instance of the component (not a text mockup) — found live:
 * since the dev instrumentation (babel-loader.js) tags every .tsx file's
 * JSX regardless of which folder it's in or where it ends up mounted at
 * runtime, a live-rendered preview here is exactly as inspectable/editable
 * via the normal Inspect → EditPanel flow as any on-page element — no new
 * code needed for that part, confirmed with a real patch round-trip.
 *
 * Dragging a tile onto the page inserts a NEW instance elsewhere; the drop
 * handling itself (finding the nearest tagged element, drawing the
 * insertion line, sending the patch) lives in VisualEditorOverlay.tsx —
 * same split as CommentPin, this panel only starts the drag.
 */
export function DesignSystemPanel({ onClose }: DesignSystemPanelProps) {
  const [components, setComponents] = useState<DesignSystemComponent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadComponents = () => {
    fetch("/api/vle/design-system")
      .then((res) => res.json())
      .then((result) => {
        if (result.ok) setComponents(result.components);
        else setError(result.reason ?? "failed to load design system");
      })
      .catch((err) => setError(String(err)));
  };

  useEffect(loadComponents, []);

  // "Generate design system" — a local, single-purpose instance of the
  // exact same chatRunner.ts conveyor VisualEditorOverlay's own ChatPanel
  // uses (start → message → poll → diff → Apply/Discard), just with its
  // own compact UI instead of opening the full chat sidebar, and its own
  // canned first message instead of free-form conversation. No backend
  // changes needed for this at all — /api/vle/chat already supports a task
  // with no clicked element and a diff-review gate before anything lands.
  const [genOpen, setGenOpen] = useState(false);
  const [genPrompt, setGenPrompt] = useState(DEFAULT_GENERATE_PROMPT);
  const [genChat, setGenChat] = useState<ChatView | null>(null);
  const [genDiffOpen, setGenDiffOpen] = useState(false);

  useEffect(() => {
    if (!genChat || genChat.status !== "running") return;
    const interval = setInterval(async () => {
      const res = await fetch(`/api/vle/chat?chatId=${genChat.id}`);
      const result = await res.json();
      if (result.ok) setGenChat(result.chat);
    }, GENERATE_POLL_MS);
    return () => clearInterval(interval);
  }, [genChat]);

  const startGenerate = async () => {
    setGenOpen(false);
    const startRes = await fetch("/api/vle/chat", { method: "POST" });
    const startResult = await startRes.json();
    if (!startResult.ok) {
      setGenChat({ id: "", status: "error", messages: [], currentSteps: [], createdAt: Date.now(), error: startResult.reason });
      return;
    }
    const chatId = startResult.chatId;
    setGenChat({ id: chatId, status: "running", messages: [{ role: "user", text: genPrompt }], currentSteps: [], createdAt: Date.now() });
    const res = await fetch("/api/vle/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, text: genPrompt }),
    });
    const result = await res.json();
    if (!result.ok) {
      setGenChat((prev) => (prev ? { ...prev, status: "error", error: result.reason ?? "failed to start" } : prev));
    }
  };

  const applyGenerate = async () => {
    if (!genChat) return;
    const res = await fetch("/api/vle/chat/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: genChat.id }),
    });
    const result = await res.json();
    if (!result.ok) {
      setGenChat({ ...genChat, status: "error", error: result.reason ?? "apply failed" });
      return;
    }
    setGenChat(null);
    setGenDiffOpen(false);
    loadComponents(); // pick up the newly-created components right away
  };

  const discardGenerate = async () => {
    if (!genChat) return;
    await fetch("/api/vle/chat/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: genChat.id }),
    });
    setGenChat(null);
    setGenDiffOpen(false);
  };

  const onDragStart = (c: DesignSystemComponent) => (e: React.DragEvent) => {
    const elementSnippet = c.hasChildren ? `<${c.name}>${c.name}</${c.name}>` : `<${c.name} />`;
    const payload: DraggedComponentPayload = { name: c.name, elementSnippet, importName: c.name, importFrom: `@/${c.dir}` };
    e.dataTransfer.setData(VLE_COMPONENT_DND_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "copy";
  };

  return createPortal(
    <div
      style={{
        position: "fixed",
        top: 16,
        left: 420,
        width: 260,
        maxHeight: "calc(100vh - 32px)",
        overflowY: "auto",
        background: "#111827",
        color: "white",
        border: "1px solid #374151",
        borderRadius: 8,
        padding: 14,
        zIndex: 999998,
        fontFamily: "system-ui, sans-serif",
        boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <strong style={{ fontSize: 13 }}>🧩 Design system</strong>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#9CA3AF", cursor: "pointer" }}>
          ✕
        </button>
      </div>
      <div style={{ fontSize: 10, color: "#6B7280", marginBottom: 10 }}>Drag a component onto the page to insert it.</div>

      {!genChat && (
        <div style={{ marginBottom: 12 }}>
          {!genOpen ? (
            <button
              onClick={() => setGenOpen(true)}
              style={{ width: "100%", fontSize: 12, padding: "8px 0", borderRadius: 6, border: "1px dashed #374151", background: "transparent", color: "var(--vle-accent, #9b8ec4)", cursor: "pointer" }}
            >
              ✨ {components && components.length > 0 ? "Add more components" : "Generate design system"}
            </button>
          ) : (
            <div>
              <textarea
                value={genPrompt}
                onChange={(e) => setGenPrompt(e.target.value)}
                rows={7}
                style={{ width: "100%", fontSize: 11, lineHeight: 1.4, background: "#1F2937", color: "white", border: "1px solid #374151", borderRadius: 4, padding: 6, resize: "vertical" }}
              />
              <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                <button
                  onClick={startGenerate}
                  disabled={!genPrompt.trim()}
                  style={{ flex: 1, fontSize: 12, padding: "6px 0", borderRadius: 4, border: "none", background: genPrompt.trim() ? "var(--vle-accent, #9b8ec4)" : "#374151", color: "white", cursor: genPrompt.trim() ? "pointer" : "default" }}
                >
                  Start
                </button>
                <button
                  onClick={() => setGenOpen(false)}
                  style={{ fontSize: 12, padding: "6px 10px", borderRadius: 4, border: "1px solid #374151", background: "#1F2937", color: "white", cursor: "pointer" }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {genChat && (
        <div style={{ marginBottom: 12, borderRadius: 6, border: "1px solid #374151", background: "#1F2937", overflow: "hidden" }}>
          <div style={{ padding: 10 }}>
            {genChat.status === "running" && (
              <div style={{ fontSize: 11, color: "#9CA3AF" }}>
                🤖 Generating… {genChat.currentSteps.length ? genChat.currentSteps[genChat.currentSteps.length - 1] : "starting"}
              </div>
            )}
            {genChat.status === "error" && <div style={{ fontSize: 11, color: "#F87171", marginBottom: genChat.diffText?.trim() ? 6 : 0 }}>{genChat.error}</div>}
            {/* Diff shown whenever there IS one, regardless of status — found
                live: a big generation hit --max-budget-usd mid-turn (ends in
                "error", no clean result line) after already writing 13 real
                component files. Gating this on status==="idle" would have
                made that real progress only reachable via Discard. */}
            {genChat.status !== "running" && genChat.diffText?.trim() && (
              <button
                onClick={() => setGenDiffOpen((v) => !v)}
                style={{ width: "100%", textAlign: "left", background: "none", border: "none", color: "#9CA3AF", fontSize: 11, cursor: "pointer", padding: 0 }}
              >
                {genDiffOpen ? "▾" : "▸"} {genChat.diffStat?.trim() ? genChat.diffStat.trim().split("\n").pop() : "changes pending"}
              </button>
            )}
          </div>
          {genDiffOpen && genChat.status !== "running" && genChat.diffText?.trim() && (
            <pre style={{ margin: 0, padding: 10, fontSize: 10, lineHeight: 1.5, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", borderTop: "1px solid #374151" }}>
              {genChat.diffText}
            </pre>
          )}
          {genChat.status !== "running" && (
            <div style={{ display: "flex", gap: 4, padding: 10, borderTop: "1px solid #374151" }}>
              {genChat.diffText?.trim() && (
                <button
                  onClick={applyGenerate}
                  style={{ flex: 1, fontSize: 12, padding: "6px 0", borderRadius: 4, border: "none", background: "var(--vle-accent, #9b8ec4)", color: "white", cursor: "pointer" }}
                >
                  Apply
                </button>
              )}
              <button
                onClick={discardGenerate}
                style={{ flex: 1, fontSize: 12, padding: "6px 0", borderRadius: 4, border: "1px solid #374151", background: "#111827", color: "white", cursor: "pointer" }}
              >
                Discard
              </button>
            </div>
          )}
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: "#F87171" }}>{error}</div>}
      {!components && !error && <div style={{ fontSize: 12, color: "#6B7280" }}>Loading…</div>}

      {components?.map((c) => (
        <div
          key={`${c.dir}/${c.name}`}
          draggable
          onDragStart={onDragStart(c)}
          title={c.description}
          style={{ marginBottom: 8, borderRadius: 6, overflow: "hidden", border: "1px solid #374151", cursor: "grab" }}
        >
          {/* White canvas — these components are designed against the
              site's actual (light) background, not this panel's dark
              chrome; rendering them here as-is would misrepresent variants
              like "ghost"/ outline styles. */}
          <div style={{ background: "white", padding: 14, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 44 }}>
            <PreviewErrorBoundary fallback={<span style={{ fontSize: 11, color: "#6B7280" }}>{c.name}</span>}>
              <Suspense fallback={<span style={{ fontSize: 11, color: "#6B7280" }}>…</span>}>
                <ComponentPreview dir={c.dir} name={c.name} hasChildren={c.hasChildren} />
              </Suspense>
            </PreviewErrorBoundary>
          </div>
          <div style={{ background: "#1F2937", padding: "6px 10px" }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>{c.name}</div>
            {c.description && <div style={{ fontSize: 10, color: "#9CA3AF", marginTop: 2 }}>{c.description}</div>}
          </div>
        </div>
      ))}
    </div>,
    document.body
  );
}
