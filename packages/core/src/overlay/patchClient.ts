"use client";

/** Shared by EditPanel and ResizeHandles — same file/vleId derivation, same fetch. */
export function fileAndIdFor(el: HTMLElement): { file: string; vleId: string } {
  const vleId = el.getAttribute("data-vle-id") ?? "";
  const vleLoc = el.getAttribute("data-vle-loc") ?? "";
  const file = vleLoc.split(":").slice(0, -2).join(":"); // "path/to/File.tsx:12:4" -> "path/to/File.tsx"
  return { file, vleId };
}

export interface PatchResponse {
  ok: boolean;
  reason?: string;
  canUndo: boolean;
  canRedo: boolean;
}

export async function postPatch(body: unknown): Promise<PatchResponse> {
  const res = await fetch("/api/vle/patch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
