/**
 * Locates the JSX source behind a clicked element and builds the prompt
 * handed to the headless Claude Code agent (see agentRunner.ts). Reuses the
 * exact same recompute-the-hash lookup as patch.ts/hashId.js — the vle-id
 * was never written to disk, only computed transiently by the webpack
 * loader, so re-parsing the real file and recomputing is the only way back
 * to the node a click referred to.
 */
import * as parser from "@babel/parser";
import traverseModule from "@babel/traverse";
import * as t from "@babel/types";
import fs from "node:fs";
import { computeVleId } from "./hashId.js";
import { resolveProjectFile } from "./patch";

const traverse: typeof import("@babel/traverse").default =
  (traverseModule as any).default ?? (traverseModule as any);

export interface LocatedElement {
  file: string;
  lineNumber: number;
  snippet: string;
}

/** Re-parses `file` and finds the JSXElement (opening tag + children + closing tag) matching `vleId`, same recompute-the-hash approach as patch.ts. */
export function locateElement(projectRoot: string, file: string, vleId: string): LocatedElement | { reason: string } {
  const absPath = resolveProjectFile(projectRoot, file);
  if (!absPath) return { reason: "file path escapes the project root — refused." };
  if (!fs.existsSync(absPath)) return { reason: `file not found: ${file}` };

  const source = fs.readFileSync(absPath, "utf8");
  let ast: ReturnType<typeof parser.parse>;
  try {
    ast = parser.parse(source, { sourceType: "module", plugins: ["jsx", "typescript"] });
  } catch (err) {
    return { reason: `file failed to parse: ${(err as Error).message}` };
  }

  let openingTag: t.JSXOpeningElement | null = null;
  traverse(ast, {
    JSXOpeningElement(nodePath: any) {
      if (openingTag) return;
      const node = nodePath.node as t.JSXOpeningElement;
      if (computeVleId(file, node.start) === vleId) openingTag = node;
    },
  });
  if (!openingTag) {
    return { reason: `no element with vleId="${vleId}" found in ${file} — file may have changed since the page loaded, reload and retry.` };
  }

  const resolvedOpeningTag = openingTag as t.JSXOpeningElement;
  let element: t.JSXElement | null = null;
  traverse(ast, {
    JSXElement(nodePath: any) {
      if (nodePath.node.openingElement === resolvedOpeningTag) element = nodePath.node;
    },
  });
  // Self-closing elements have no JSXElement wrapper in some Babel shapes —
  // fall back to just the opening tag's own span.
  const start = element ? (element as t.JSXElement).start : resolvedOpeningTag.start;
  const end = element ? (element as t.JSXElement).end : resolvedOpeningTag.end;
  if (start == null || end == null) return { reason: "couldn't locate element position." };

  const lineNumber = source.slice(0, start).split("\n").length;
  const snippet = source.slice(start, end);
  return { file, lineNumber, snippet };
}

/**
 * Framed so the agent knows it has repo-wide freedom but isn't told *how*
 * to explore — it has its own Read/Grep/Bash tools, same as any normal
 * Claude Code session, so it can find relevant code itself rather than
 * being spoon-fed file paths for code we haven't looked at.
 *
 * `promptContext` is the consuming project's own description of itself
 * (stack, structure, conventions) — see VleConfig.promptContext. This
 * function doesn't know or care what that project actually is.
 */
export function buildAgentPrompt(promptContext: string, located: LocatedElement, userPrompt: string): string {
  return `${promptContext} You have full read/write access to this checkout — it's an isolated git worktree made specifically for this task, so feel free to edit any file the request needs.

The user clicked on this element in a browser-based visual editor and left a comment on it:

File: ${located.file}
Around line: ${located.lineNumber}

\`\`\`tsx
${located.snippet}
\`\`\`

User's request: ${userPrompt}

Guidelines:
- Make the code changes needed to fulfill the request, wherever in the repo they belong.
- Stay scoped to what this request actually needs — don't refactor unrelated code.
- Do not run destructive git operations, do not push, do not touch CI/CD or deployment configs unless the request explicitly asks for that.
- Leave your changes as uncommitted working-tree edits — do not commit.`;
}

/**
 * Frames the *first* message of a standalone chat session (chatRunner.ts)
 * — no clicked element, so no file/line/snippet to hand over. Explicitly
 * says the request might be a pure question, since that's the whole reason
 * this differs from the comment-pin flow: "check if we have good responsive
 * adaptation" shouldn't produce an edit just because file-write access is
 * available.
 */
export function buildChatPrompt(promptContext: string, userText: string): string {
  return `${promptContext} You have full read/write access to this checkout — it's an isolated git worktree made specifically for this conversation, so feel free to edit any file if the request needs it.

The developer's message may be a question that just needs looking into and answering (e.g. "do we handle mobile screens well?"), or a request to actually change code. Infer which from the message itself — only edit files if the request clearly asks for a change; otherwise just look and answer in plain text.

Developer: ${userText}

Guidelines (only relevant if you do end up editing files):
- Stay scoped to what the request actually needs — don't refactor unrelated code.
- Do not run destructive git operations, do not push, do not touch CI/CD or deployment configs unless explicitly asked.
- Leave any changes as uncommitted working-tree edits — do not commit.`;
}
