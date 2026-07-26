"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useInspector } from "./useInspector";
import { HighlightBox } from "./HighlightBox";
import { EditPanel } from "./EditPanel";
import { ResizeHandles } from "./ResizeHandles";
import { ReorderHandle } from "./ReorderHandle";
import { preloadFontLibrary } from "./fontLibrary";
import { CommentPin } from "./CommentPin";
import { AgentJobPanel, type AgentJobView } from "./AgentJobPanel";
import { ResponsivePreview } from "./ResponsivePreview";
import { ChatPanel, type ChatView } from "./ChatPanel";
import { DesignSystemPanel, VLE_COMPONENT_DND_MIME, type DraggedComponentPayload } from "./DesignSystemPanel";
import { CreativesPanel, VLE_CREATIVE_DND_MIME, type DraggedCreativePayload } from "./CreativesPanel";
import { InsertionLine, type InsertionIndicator } from "./InsertionLine";
import { fileAndIdFor, postPatch } from "./patchClient";

interface HistoryStatus {
  canUndo: boolean;
  canRedo: boolean;
}

const JOB_POLL_MS = 3000;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

/**
 * Framework-agnostic base — computes the ?vle_hide=1 / "inside an iframe"
 * check synchronously from window.location.search. Safe with zero flash
 * for pure client-rendered apps (Vite, CRA): there's no separate SSR pass
 * to disagree with, so `window` is always defined by the time this first
 * runs. Frameworks that DO server-render this component (Next.js) should
 * not rely on this default — see hideForPreview below.
 */
function computeDefaultHide(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("vle_hide") === "1" || window.self !== window.top;
}

/**
 * Mounted once at the app's root, gated to development only there — this
 * component itself doesn't re-check NODE_ENV so it can be unit-tested, the
 * gate belongs at the mount site.
 */
export interface VisualEditorOverlayProps {
  /** Accent color for the editor's own UI chrome. Set via a document-level CSS custom property (--vle-accent) so every overlay component can pick it up regardless of where it mounts in the DOM. Defaults to VLE's own purple. */
  accentColor?: string;
  /**
   * Overrides the ?vle_hide=1 / iframe check computeDefaultHide() makes by
   * default. Only frameworks that server-render this component need this —
   * see vle-editor/overlay/adapters/next's VisualEditorOverlay, which supplies an
   * SSR-safe value here via next/navigation's useSearchParams(). Reading
   * window.location.search directly during an SSR pass would always
   * disagree with the client's first paint and produce a hydration
   * mismatch — that's the one thing the framework-agnostic default here
   * can't safely do on its own.
   */
  hideForPreview?: boolean;
}

export function VisualEditorOverlay({ accentColor, hideForPreview }: VisualEditorOverlayProps = {}) {
  const [defaultHide] = useState(computeDefaultHide);
  const hideForResponsivePreview = hideForPreview ?? defaultHide;

  useEffect(() => {
    document.documentElement.style.setProperty("--vle-accent", accentColor ?? "#9b8ec4");
  }, [accentColor]);

  // Whether EditPanel's controls should write Tailwind classes or real
  // inline styles — server-side config (vle.config.ts's stylingMode) the
  // browser has no way to read on its own. Defaults to "tailwind" (the
  // long-established behavior) until this resolves, rather than flashing
  // every field into a different write-mode a moment after mount.
  const [stylingMode, setStylingMode] = useState<"tailwind" | "inline">("tailwind");
  useEffect(() => {
    fetch("/api/vle/meta")
      .then((res) => res.json())
      .then((result) => {
        if (result?.ok && (result.stylingMode === "tailwind" || result.stylingMode === "inline")) {
          setStylingMode(result.stylingMode);
        }
      })
      .catch(() => {
        // Best-effort — worst case, controls stay in the "tailwind" default.
      });
  }, []);

  const { inspecting, toggleInspecting, hoveredEl, selectedEl, selectElement } = useInspector();
  const [history, setHistory] = useState<HistoryStatus>({ canUndo: false, canRedo: false });
  const [responsiveOpen, setResponsiveOpen] = useState(false);

  // Independent second picker for "leave a comment for the agent" — useInspector
  // is already self-contained/reusable for exactly this ("pick a tagged element"),
  // so a second instance is simpler than threading a mode flag through the first.
  const { inspecting: commenting, toggleInspecting: toggleCommenting, hoveredEl: commentHoveredEl, selectedEl: commentTargetEl, selectElement: selectCommentTarget } = useInspector();
  const [job, setJob] = useState<AgentJobView | null>(null);

  // Global chat — independent of both pickers above: not about one clicked
  // element, and a message might just be a question. See chatRunner.ts.
  const [chatOpen, setChatOpen] = useState(false);
  const [chat, setChat] = useState<ChatView | null>(null);

  // Design-system palette drag-and-drop — insertIndicator/dropTargetRef
  // mirror ReorderHandle's own indicator state, but the source here is an
  // external palette tile, not an on-page element, so the drop target is
  // found fresh under the cursor on every dragover (document.elementFromPoint
  // equivalent via e.target + closest), not narrowed to one parent's siblings.
  const [designSystemOpen, setDesignSystemOpen] = useState(false);
  const [creativesOpen, setCreativesOpen] = useState(false);
  const [insertIndicator, setInsertIndicator] = useState<InsertionIndicator | null>(null);
  // Hovering an element the server would refuse anyway (data-vle-nonliteral
  // — same .map()/conditional-parent check patch.ts's applyInsert makes,
  // computed once at instrumentation time by babel-loader.js) — shown
  // *during* the drag instead of only learning this after a failed drop.
  const [blockedRect, setBlockedRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const dropTargetRef = useRef<{ el: HTMLElement; position: "before" | "after" } | null>(null);

  const callHistoryEndpoint = useCallback(async (endpoint: "undo" | "redo") => {
    const res = await fetch(`/api/vle/${endpoint}`, { method: "POST" });
    const result = await res.json();
    setHistory({ canUndo: !!result.canUndo, canRedo: !!result.canRedo });
  }, []);

  // Poll the running job's status — same pattern as the undo/redo status
  // fetch above, just on an interval instead of button clicks, since a job
  // (and, once done, its optional preview server) finishes in the
  // background without any user action to trigger a refetch. Keeps polling
  // while the preview server is booting too — that also happens
  // asynchronously, after the job itself already reports "done".
  useEffect(() => {
    if (!job) return;
    if (job.status !== "running" && job.previewStatus !== "starting") return;
    const interval = setInterval(async () => {
      const res = await fetch(`/api/vle/agent?jobId=${job.id}`);
      const result = await res.json();
      if (result.ok) setJob(result.job);
    }, JOB_POLL_MS);
    return () => clearInterval(interval);
  }, [job]);

  const previewJob = useCallback(async () => {
    if (!job) return;
    setJob({ ...job, previewStatus: "starting" });
    const res = await fetch("/api/vle/agent/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: job.id }),
    });
    const result = await res.json();
    if (!result.ok) {
      setJob((prev) => (prev ? { ...prev, previewStatus: "error", previewError: result.reason ?? "preview failed" } : prev));
    }
  }, [job]);

  const refineJob = useCallback(
    async (prompt: string) => {
      if (!job) return;
      // Optimistic: flips the panel back to the "working…" badge immediately,
      // same as the real server-side state the next poll will confirm.
      setJob({ ...job, status: "running", diffText: undefined, previewStatus: undefined, previewPort: undefined });
      const res = await fetch("/api/vle/agent/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, prompt }),
      });
      const result = await res.json();
      if (!result.ok) {
        setJob((prev) => (prev ? { ...prev, status: "error", error: result.reason ?? "refine failed" } : prev));
      }
    },
    [job]
  );

  const discardJob = useCallback(async () => {
    if (!job) return;
    await fetch("/api/vle/agent/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: job.id }),
    });
    setJob(null);
  }, [job]);

  const applyJob = useCallback(async () => {
    if (!job) return;
    const res = await fetch("/api/vle/agent/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: job.id }),
    });
    const result = await res.json();
    if (!result.ok) {
      // Surface the failure inline rather than silently dropping it — most
      // likely cause: live files changed since the job ran, so the patch no
      // longer applies cleanly.
      setJob({ ...job, status: "error", error: result.reason ?? "apply failed" });
      return;
    }
    setJob(null);
  }, [job]);

  // Same poll-while-running pattern as the job effect above.
  useEffect(() => {
    if (!chat || chat.status !== "running") return;
    const interval = setInterval(async () => {
      const res = await fetch(`/api/vle/chat?chatId=${chat.id}`);
      const result = await res.json();
      if (result.ok) setChat(result.chat);
    }, JOB_POLL_MS);
    return () => clearInterval(interval);
  }, [chat]);

  const sendChatMessage = useCallback(
    async (text: string) => {
      let chatId = chat?.id;
      if (!chatId) {
        const startRes = await fetch("/api/vle/chat", { method: "POST" });
        const startResult = await startRes.json();
        if (!startResult.ok) {
          setChat({ id: "", status: "error", messages: [], currentSteps: [], createdAt: Date.now(), error: startResult.reason });
          return;
        }
        chatId = startResult.chatId;
      }
      // Optimistic: show the user's message + a running state immediately,
      // rather than waiting for the first poll tick.
      setChat((prev) => ({
        id: chatId!,
        status: "running",
        messages: [...(prev?.messages ?? []), { role: "user", text }],
        currentSteps: [],
        createdAt: prev?.createdAt ?? Date.now(),
        diffText: prev?.diffText,
        diffStat: prev?.diffStat,
      }));
      const res = await fetch("/api/vle/chat/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, text }),
      });
      const result = await res.json();
      if (!result.ok) {
        setChat((prev) => (prev ? { ...prev, status: "error", error: result.reason ?? "failed to send message" } : prev));
      }
    },
    [chat]
  );

  const applyChat = useCallback(async () => {
    if (!chat) return;
    const res = await fetch("/api/vle/chat/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: chat.id }),
    });
    const result = await res.json();
    if (!result.ok) {
      setChat({ ...chat, status: "error", error: result.reason ?? "apply failed" });
      return;
    }
    setChat(null);
  }, [chat]);

  const discardChat = useCallback(async () => {
    if (!chat) return;
    await fetch("/api/vle/chat/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: chat.id }),
    });
    setChat(null);
  }, [chat]);

  // Document-level, always attached (cheap no-op for any drag that isn't
  // ours) — checking dataTransfer.types lets this ignore every other kind
  // of drag on the page without needing a separate "am I dragging from the
  // palette" flag lifted up from DesignSystemPanel. Browsers only expose
  // .types (not the actual payload) during dragover for security reasons —
  // the payload itself is only readable once "drop" actually fires.
  useEffect(() => {
    const isOurDrag = (e: DragEvent) =>
      !!e.dataTransfer && (e.dataTransfer.types.includes(VLE_COMPONENT_DND_MIME) || e.dataTransfer.types.includes(VLE_CREATIVE_DND_MIME));

    const onDragOver = (e: DragEvent) => {
      if (!isOurDrag(e)) return;
      e.preventDefault();
      const dt = e.dataTransfer!;

      const hovered = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-vle-id]") : null;
      if (!hovered) {
        dropTargetRef.current = null;
        setInsertIndicator(null);
        setBlockedRect(null);
        dt.dropEffect = "none";
        return;
      }

      if (hovered.hasAttribute("data-vle-nonliteral")) {
        dropTargetRef.current = null;
        setInsertIndicator(null);
        const r = hovered.getBoundingClientRect();
        setBlockedRect({ top: r.top, left: r.left, width: r.width, height: r.height });
        dt.dropEffect = "none";
        return;
      }

      dt.dropEffect = "copy";
      setBlockedRect(null);
      const r = hovered.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      const position: "before" | "after" = e.clientY < mid ? "before" : "after";
      dropTargetRef.current = { el: hovered, position };
      setInsertIndicator({ top: position === "before" ? r.top : r.bottom, left: r.left, width: r.width });
    };

    const onDrop = async (e: DragEvent) => {
      if (!isOurDrag(e)) return;
      e.preventDefault();
      const dt = e.dataTransfer!;
      const isCreative = dt.types.includes(VLE_CREATIVE_DND_MIME);
      const raw = dt.getData(isCreative ? VLE_CREATIVE_DND_MIME : VLE_COMPONENT_DND_MIME);
      setInsertIndicator(null);
      setBlockedRect(null);
      const target = dropTargetRef.current;
      dropTargetRef.current = null;
      if (!raw || !target) return;

      const { file, vleId: targetVleId } = fileAndIdFor(target.el);

      if (isCreative) {
        let payload: DraggedCreativePayload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return;
        }

        const res = await fetch("/api/vle/creatives/insert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file,
            targetVleId,
            position: target.position,
            creativeName: payload.name,
            tag: payload.tag,
          }),
        });
        const result = await res.json();
        setHistory({ canUndo: !!result.canUndo, canRedo: !!result.canRedo });
        if (!result.ok) window.alert(result.reason ?? "couldn't insert that here");
        return;
      }

      let payload: DraggedComponentPayload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }

      const result = await postPatch({
        file,
        kind: "insert",
        targetVleId,
        position: target.position,
        elementSnippet: payload.elementSnippet,
        importName: payload.importName,
        importFrom: payload.importFrom,
      });
      setHistory({ canUndo: !!result.canUndo, canRedo: !!result.canRedo });
      if (!result.ok) window.alert(result.reason ?? "couldn't insert that here");
    };

    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, []);

  // So a font the Text panel's picker applied in an earlier session still
  // renders correctly on a fresh page load, not just live in the browser
  // tab that applied it.
  useEffect(() => {
    preloadFontLibrary();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) {
        callHistoryEndpoint("redo");
      } else {
        callHistoryEndpoint("undo");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [callHistoryEndpoint]);

  // After all hooks — rules-of-hooks safe: every hook above still runs on
  // every render regardless, this just decides what (if anything) to mount.
  if (hideForResponsivePreview) return null;

  return (
    <>
      <div
        style={{
          position: "fixed",
          bottom: 16,
          right: 16,
          zIndex: 999999,
          display: "flex",
          gap: 6,
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <button
          onClick={() => callHistoryEndpoint("undo")}
          disabled={!history.canUndo}
          title="Undo (Cmd+Z)"
          style={{
            padding: "8px 12px",
            borderRadius: 999,
            border: "none",
            background: "#111827",
            color: history.canUndo ? "white" : "#4B5563",
            fontSize: 14,
            cursor: history.canUndo ? "pointer" : "default",
            boxShadow: "0 2px 12px rgba(0,0,0,0.3)",
          }}
        >
          ↶
        </button>
        <button
          onClick={() => callHistoryEndpoint("redo")}
          disabled={!history.canRedo}
          title="Redo (Cmd+Shift+Z)"
          style={{
            padding: "8px 12px",
            borderRadius: 999,
            border: "none",
            background: "#111827",
            color: history.canRedo ? "white" : "#4B5563",
            fontSize: 14,
            cursor: history.canRedo ? "pointer" : "default",
            boxShadow: "0 2px 12px rgba(0,0,0,0.3)",
          }}
        >
          ↷
        </button>
        <button
          onClick={toggleInspecting}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            border: "none",
            background: inspecting ? "var(--vle-accent, #9b8ec4)" : "#111827",
            color: "white",
            fontSize: 12,
            cursor: "pointer",
            boxShadow: "0 2px 12px rgba(0,0,0,0.3)",
          }}
        >
          {inspecting ? "Inspecting… (click an element)" : "🖊 Inspect"}
        </button>
        <button
          onClick={toggleCommenting}
          disabled={!!job}
          title={job ? "Wait for the current agent job to finish/be discarded first" : "Ask an agent to change an element"}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            border: "none",
            background: commenting ? "var(--vle-accent, #9b8ec4)" : "#111827",
            color: job ? "#4B5563" : "white",
            fontSize: 12,
            cursor: job ? "default" : "pointer",
            boxShadow: "0 2px 12px rgba(0,0,0,0.3)",
          }}
        >
          {commenting ? "Pick an element…" : "💬 Comment"}
        </button>
        <button
          onClick={() => setResponsiveOpen(true)}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            border: "none",
            background: "#111827",
            color: "white",
            fontSize: 12,
            cursor: "pointer",
            boxShadow: "0 2px 12px rgba(0,0,0,0.3)",
          }}
        >
          📱 Responsive
        </button>
        <button
          onClick={() => setChatOpen((v) => !v)}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            border: "none",
            background: chatOpen ? "var(--vle-accent, #9b8ec4)" : "#111827",
            color: "white",
            fontSize: 12,
            cursor: "pointer",
            boxShadow: "0 2px 12px rgba(0,0,0,0.3)",
          }}
        >
          💭 Chat
        </button>
        <button
          onClick={() => setDesignSystemOpen((v) => !v)}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            border: "none",
            background: designSystemOpen ? "var(--vle-accent, #9b8ec4)" : "#111827",
            color: "white",
            fontSize: 12,
            cursor: "pointer",
            boxShadow: "0 2px 12px rgba(0,0,0,0.3)",
          }}
        >
          🧩 Design System
        </button>
        <button
          onClick={() => setCreativesOpen((v) => !v)}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            border: "none",
            background: creativesOpen ? "var(--vle-accent, #9b8ec4)" : "#111827",
            color: "white",
            fontSize: 12,
            cursor: "pointer",
            boxShadow: "0 2px 12px rgba(0,0,0,0.3)",
          }}
        >
          🎨 Creatives
        </button>
      </div>

      {responsiveOpen && <ResponsivePreview onClose={() => setResponsiveOpen(false)} />}
      {chatOpen && <ChatPanel chat={chat} onSend={sendChatMessage} onApply={applyChat} onDiscard={discardChat} onClose={() => setChatOpen(false)} />}
      {designSystemOpen && <DesignSystemPanel onClose={() => setDesignSystemOpen(false)} />}
      {creativesOpen && <CreativesPanel onClose={() => setCreativesOpen(false)} />}
      <InsertionLine indicator={insertIndicator} />
      {blockedRect && (
        <div
          title="Can't drop here — rendered via .map()/a conditional, not a literal JSX child"
          style={{
            position: "fixed",
            top: blockedRect.top,
            left: blockedRect.left,
            width: blockedRect.width,
            height: blockedRect.height,
            border: "2px dashed #F87171",
            background: "rgba(248, 113, 113, 0.08)",
            zIndex: 999999,
            pointerEvents: "none",
          }}
        />
      )}

      {inspecting && hoveredEl && <HighlightBox el={hoveredEl} color="var(--vle-accent, #9b8ec4)" label={hoveredEl.getAttribute("data-vle-loc") ?? undefined} />}
      {commenting && commentHoveredEl && <HighlightBox el={commentHoveredEl} color="#3B82F6" label={commentHoveredEl.getAttribute("data-vle-loc") ?? undefined} />}
      {commentTargetEl && !job && (
        <CommentPin
          el={commentTargetEl}
          onStarted={(jobId) => {
            setJob({ id: jobId, file: "", prompt: "", status: "running", startedAt: Date.now() });
            selectCommentTarget(null);
          }}
          onClose={() => selectCommentTarget(null)}
        />
      )}
      {job && <AgentJobPanel job={job} onApply={applyJob} onDiscard={discardJob} onPreview={previewJob} onRefine={refineJob} />}
      {selectedEl && <HighlightBox el={selectedEl} color="#34D399" />}
      {selectedEl && <ResizeHandles el={selectedEl} onPatched={setHistory} />}
      {selectedEl && (
        <ReorderHandle el={selectedEl} onPatched={setHistory} onMoved={() => selectElement(null)} />
      )}
      {selectedEl && (
        // key forces a fresh mount per element — without it, React reuses
        // the same EditPanel instance across different selections (same
        // component at the same tree position), and its children's
        // useState(initial) fields (padding/margin/rotation/colors) never
        // re-run their initializer, so they keep showing the *previous*
        // element's values (or 0) instead of the newly-selected one's real
        // ones. Found live.
        <EditPanel
          key={selectedEl.getAttribute("data-vle-id") ?? undefined}
          el={selectedEl}
          stylingMode={stylingMode}
          onClose={() => selectElement(null)}
          onPatched={setHistory}
        />
      )}
    </>
  );
}
