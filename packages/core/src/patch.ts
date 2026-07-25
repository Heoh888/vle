/**
 * Core codemod: find a JSX element by its (recomputed, see hashId.js)
 * vle-id and rewrite either its className or its text content — as a
 * surgical splice on the raw source string, not a full-file re-parse/
 * re-generate. This guarantees every byte of the file outside the touched
 * literal stays untouched (formatting, comments, unrelated code) — a full
 * AST regenerate (Babel's generator, or even ts-morph's mutation API) risks
 * reformatting things a human didn't ask to change.
 *
 * Deliberately scoped (see docs/план-frontend-docs.md discussion): only
 * handles the common cases (plain string className, single text child).
 * Anything more complex (clsx()/twMerge() calls, template literals,
 * conditional children) is refused with a reason rather than risking a
 * silent code-corrupting edit — this is the boundary of v1's scope, not a
 * bug to fix later without deciding to expand scope first.
 */
import * as parser from "@babel/parser";
import traverseModule from "@babel/traverse";
import * as t from "@babel/types";
import { twMerge } from "tailwind-merge";
import fs from "node:fs";
import path from "node:path";
import { computeVleId } from "./hashId.js";

const traverse: typeof import("@babel/traverse").default =
  (traverseModule as any).default ?? (traverseModule as any);

export type PatchRequest =
  | { file: string; vleId: string; kind: "className"; value: string; replace?: boolean }
  | { file: string; vleId: string; kind: "text"; value: string }
  | { file: string; vleId: string; kind: "style"; property: string; value: number | string }
  | { file: string; vleId: string; kind: "styleDelete"; property: string }
  | { file: string; kind: "reorder"; draggedVleId: string; targetVleId: string; position: "before" | "after" }
  | { file: string; vleId: string; kind: "delete" }
  | {
      file: string;
      kind: "insert";
      targetVleId: string;
      position: "before" | "after";
      elementSnippet: string;
      importName?: string;
      importFrom?: string;
    };

export type PatchResult = { ok: true } | { ok: false; reason: string };

/** Resolves `file` strictly inside `root` — rejects any path traversal attempt. */
export function resolveProjectFile(root: string, file: string): string | null {
  const abs = path.resolve(root, file);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!abs.startsWith(rootWithSep)) return null;
  return abs;
}

/** Escape characters that are syntactically special in JSX text position. */
function escapeJsxText(value: string): string {
  return value.replace(/[{<>}]/g, (c) => ({ "{": "&#123;", "<": "&lt;", ">": "&gt;", "}": "&#125;" })[c]!);
}

export function applyPatch(projectRoot: string, req: PatchRequest): PatchResult {
  const absPath = resolveProjectFile(projectRoot, req.file);
  if (!absPath) {
    return { ok: false, reason: "file path escapes the project root — refused." };
  }
  if (!fs.existsSync(absPath)) {
    return { ok: false, reason: `file not found: ${req.file}` };
  }

  const relPath = req.file; // already project-relative, matches what the loader hashes
  const source = fs.readFileSync(absPath, "utf8");

  let ast: ReturnType<typeof parser.parse>;
  try {
    ast = parser.parse(source, { sourceType: "module", plugins: ["jsx", "typescript"] });
  } catch (err) {
    return { ok: false, reason: `file failed to parse: ${(err as Error).message}` };
  }

  if (req.kind === "reorder") {
    return applyReorder(absPath, source, ast, relPath, req.draggedVleId, req.targetVleId, req.position);
  }
  if (req.kind === "insert") {
    return applyInsert(absPath, source, ast, relPath, req.targetVleId, req.position, req.elementSnippet, req.importName, req.importFrom);
  }

  let target: t.JSXOpeningElement | null = null;
  traverse(ast, {
    JSXOpeningElement(nodePath: any) {
      const node = nodePath.node as t.JSXOpeningElement;
      if (target) return;
      if (computeVleId(relPath, node.start) === req.vleId) {
        target = node;
      }
    },
  });

  if (!target) {
    return {
      ok: false,
      reason: `no element with vleId="${req.vleId}" found in ${req.file} — file may have changed since the page loaded, reload and retry.`,
    };
  }

  if (req.kind === "className") {
    return applyClassName(absPath, source, target, req.value, !!req.replace);
  }
  if (req.kind === "style") {
    return applyStyle(absPath, source, target, req.property, req.value);
  }
  if (req.kind === "styleDelete") {
    return applyStyleDelete(absPath, source, target, req.property);
  }
  if (req.kind === "delete") {
    return applyDelete(absPath, source, ast, target);
  }
  return applyText(absPath, source, ast, target, req.value);
}

/**
 * `replace: false` (default, used by the curated token/color/number rows) —
 * merges one utility into the existing className via twMerge (only
 * resolves same-category conflicts, e.g. a new bg-* replaces the old bg-*
 * but leaves everything else). `replace: true` (the raw className editor) —
 * the new value IS the new className, verbatim, no merge — the only way to
 * actually remove a class, not just override same-category ones.
 */
function applyClassName(
  absPath: string,
  source: string,
  tag: t.JSXOpeningElement,
  newValue: string,
  replace: boolean
): PatchResult {
  const attr = tag.attributes.find(
    (a): a is t.JSXAttribute => t.isJSXAttribute(a) && a.name.name === "className"
  );

  if (!attr) {
    // No className yet — insert one right after the tag name.
    const insertAt = tag.name.end!;
    const insertion = ` className=${JSON.stringify(newValue)}`;
    fs.writeFileSync(absPath, source.slice(0, insertAt) + insertion + source.slice(insertAt), "utf8");
    return { ok: true };
  }

  const value = attr.value;
  const literal =
    value && t.isStringLiteral(value)
      ? value
      : value && t.isJSXExpressionContainer(value) && t.isStringLiteral(value.expression)
        ? value.expression
        : null;

  if (!literal || literal.start == null || literal.end == null) {
    return {
      ok: false,
      reason: "className isn't a plain string literal (clsx()/twMerge()/template literal/conditional) — v1 doesn't edit these, edit the source directly.",
    };
  }

  const finalValue = replace ? newValue : twMerge(literal.value, newValue);
  const replaced = source.slice(0, literal.start) + JSON.stringify(finalValue) + source.slice(literal.end);
  fs.writeFileSync(absPath, replaced, "utf8");
  return { ok: true };
}

/**
 * Edits a single numeric property inside a JSX `style={{...}}` object —
 * the counterpart to applyClassName for elements sized via inline style
 * (e.g. components/landing/FeaturesSection.tsx's cards, style={{width: 290,
 * height: 223.5}}) rather than Tailwind w-* / h-* classes. Same splice
 * discipline: touches only the one property's literal, or inserts a new
 * property — never regenerates the whole object.
 */
/** Numbers render as-is (opacity: 0.5); strings render quoted (background: "#fff"). */
function literalText(value: number | string): string {
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}

function applyStyle(
  absPath: string,
  source: string,
  tag: t.JSXOpeningElement,
  property: string,
  newValue: number | string
): PatchResult {
  const attr = tag.attributes.find((a): a is t.JSXAttribute => t.isJSXAttribute(a) && a.name.name === "style");
  const newText = literalText(newValue);

  if (!attr) {
    const insertAt = tag.name.end!;
    const insertion = ` style={{${property}: ${newText}}}`;
    fs.writeFileSync(absPath, source.slice(0, insertAt) + insertion + source.slice(insertAt), "utf8");
    return { ok: true };
  }

  const value = attr.value;
  const objectExpr =
    value && t.isJSXExpressionContainer(value) && t.isObjectExpression(value.expression) ? value.expression : null;

  if (!objectExpr) {
    return {
      ok: false,
      reason: "style isn't a plain object literal (style={someVar} or a spread) — v1 doesn't edit these, edit the source directly.",
    };
  }

  const existingProp = objectExpr.properties.find(
    (p): p is t.ObjectProperty =>
      t.isObjectProperty(p) &&
      !p.computed &&
      ((t.isIdentifier(p.key) && p.key.name === property) || (t.isStringLiteral(p.key) && p.key.value === property))
  );

  if (existingProp) {
    const propValue = existingProp.value;
    // Accept a plain number OR string literal as the existing value —
    // replacing its text is safe regardless of whether old/new types match
    // (e.g. a numeric 0 being replaced by a color string is a legitimate edit).
    if ((!t.isNumericLiteral(propValue) && !t.isStringLiteral(propValue)) || propValue.start == null || propValue.end == null) {
      return {
        ok: false,
        reason: `style.${property} isn't a plain number/string literal (template literal/expression) — v1 doesn't edit these, edit the source directly.`,
      };
    }
    const replaced = source.slice(0, propValue.start) + newText + source.slice(propValue.end);
    fs.writeFileSync(absPath, replaced, "utf8");
    return { ok: true };
  }

  // Property doesn't exist yet — insert it just before the object's closing "}".
  if (objectExpr.start == null || objectExpr.end == null) {
    return { ok: false, reason: "couldn't locate the style object's position." };
  }
  const insertAt = objectExpr.end - 1;
  // Found live: naively prepending ", " broke files whose last property
  // already had a trailing comma before "}" (multi-line object literals
  // commonly do) — produced "prop: val,\n  , newProp: v}" (double comma,
  // invalid syntax). Look at what actually precedes the insertion point.
  const trimmedBefore = source.slice(0, insertAt).trimEnd();
  let insertion: string;
  if (trimmedBefore.endsWith("{")) {
    insertion = `${property}: ${newText}`;
  } else if (trimmedBefore.endsWith(",")) {
    insertion = ` ${property}: ${newText},`;
  } else {
    insertion = `, ${property}: ${newText}`;
  }
  const replaced = source.slice(0, insertAt) + insertion + source.slice(insertAt);
  fs.writeFileSync(absPath, replaced, "utf8");
  return { ok: true };
}

/**
 * Removes a property from a JSX `style={{...}}` object entirely — the
 * counterpart to applyStyle's insert/update. Needed for e.g. "no
 * background color": setting className="bg-transparent" has zero visual
 * effect if the element already has style={{backgroundColor: "..."}} —
 * inline style always wins over a class (found live, same root cause as
 * the resize width/height split). Unlike applyStyle, doesn't care whether
 * the existing value is numeric or a string — deleting doesn't need to
 * inspect the value's type, just locate and remove the whole `key: value`.
 */
function applyStyleDelete(absPath: string, source: string, tag: t.JSXOpeningElement, property: string): PatchResult {
  const attr = tag.attributes.find((a): a is t.JSXAttribute => t.isJSXAttribute(a) && a.name.name === "style");
  if (!attr) return { ok: true }; // no style attribute at all — already "not set"

  const value = attr.value;
  const objectExpr =
    value && t.isJSXExpressionContainer(value) && t.isObjectExpression(value.expression) ? value.expression : null;
  if (!objectExpr) {
    return {
      ok: false,
      reason: "style isn't a plain object literal (style={someVar} or a spread) — can't safely remove a property here.",
    };
  }

  const prop = objectExpr.properties.find(
    (p): p is t.ObjectProperty =>
      t.isObjectProperty(p) &&
      !p.computed &&
      ((t.isIdentifier(p.key) && p.key.name === property) || (t.isStringLiteral(p.key) && p.key.value === property))
  );
  if (!prop) return { ok: true }; // property not present — already "not set"
  if (prop.start == null || prop.end == null) {
    return { ok: false, reason: "couldn't locate the property's position." };
  }

  // Remove the property plus one adjacent comma — prefer a trailing comma
  // (the common case, since the last property in a multi-line object often
  // has one too) and only fall back to a leading comma if there's none.
  let removeStart = prop.start;
  let removeEnd = prop.end;
  const trailingComma = source.slice(prop.end).match(/^\s*,/);
  if (trailingComma) {
    removeEnd = prop.end + trailingComma[0].length;
  } else {
    const leadingComma = source.slice(0, prop.start).match(/,\s*$/);
    if (leadingComma) removeStart = prop.start - leadingComma[0].length;
  }

  const replaced = source.slice(0, removeStart) + source.slice(removeEnd);
  fs.writeFileSync(absPath, replaced, "utf8");
  return { ok: true };
}

function applyText(
  absPath: string,
  source: string,
  ast: ReturnType<typeof parser.parse>,
  openingTag: t.JSXOpeningElement,
  newText: string
): PatchResult {
  if (openingTag.selfClosing) {
    return { ok: false, reason: "self-closing element has no text children to edit." };
  }

  let jsxElement: t.JSXElement | null = null;
  traverse(ast, {
    JSXElement(nodePath: any) {
      if (nodePath.node.openingElement === openingTag) {
        jsxElement = nodePath.node;
      }
    },
  });
  if (!jsxElement) {
    return { ok: false, reason: "couldn't locate the parent JsxElement for this opening tag." };
  }

  const children = (jsxElement as t.JSXElement).children;
  const textChildren = children.filter((c) => t.isJSXText(c));

  if (children.length !== 1 || textChildren.length !== 1) {
    return {
      ok: false,
      reason: "element has mixed/nested children (not a single text node) — v1 doesn't edit these, edit the source directly.",
    };
  }

  const textNode = textChildren[0] as t.JSXText;
  if (textNode.start == null || textNode.end == null) {
    return { ok: false, reason: "couldn't locate text node position." };
  }

  // Preserve surrounding whitespace/indentation — only the trimmed content
  // between it is meaningful text, JSX collapses insignificant whitespace
  // at render time but it still matters for the file staying readable.
  const raw = source.slice(textNode.start, textNode.end);
  const leading = raw.match(/^\s*/)?.[0] ?? "";
  const trailing = raw.match(/\s*$/)?.[0] ?? "";

  const replaced =
    source.slice(0, textNode.start) + leading + escapeJsxText(newText) + trailing + source.slice(textNode.end);
  fs.writeFileSync(absPath, replaced, "utf8");
  return { ok: true };
}

/** True if a whitespace-only JSXText — the indentation/newline between two real siblings. */
function isWhitespaceOnlyText(node: t.Node | null | undefined): node is t.JSXText {
  return !!node && t.isJSXText(node) && /^\s*$/.test(node.value);
}

/**
 * Moves a whole JSX element (from `<Tag` to `</Tag>`/`/>`, including its own
 * children — a subtree, not just the opening tag) before/after a sibling
 * under the same parent. Deliberately refuses two cases rather than risking
 * a wrong-looking result:
 *  - dragged/target aren't literal children of the same JSXElement/Fragment
 *    (e.g. one of them is produced by `.map()`, a ternary, `&&` — anything
 *    where the JSX in source appears once but renders N times or
 *    conditionally; reordering *that* means reordering the underlying data,
 *    a different, harder operation not attempted here — found live via
 *    components/landing/FeaturesSection.tsx, whose 4 cards are ONE JSX
 *    template mapped over a `FEATURES` array, not 4 separate elements)
 *  - dragged and target have different parents (cross-parent moves aren't
 *    attempted — the plan's "not free positioning" boundary)
 */
function applyReorder(
  absPath: string,
  source: string,
  ast: ReturnType<typeof parser.parse>,
  relPath: string,
  draggedVleId: string,
  targetVleId: string,
  position: "before" | "after"
): PatchResult {
  let draggedPath: any = null;
  let targetPath: any = null;

  traverse(ast, {
    JSXElement(nodePath: any) {
      const opening = nodePath.node.openingElement as t.JSXOpeningElement;
      const id = computeVleId(relPath, opening.start);
      if (id === draggedVleId) draggedPath = nodePath;
      if (id === targetVleId) targetPath = nodePath;
    },
  });

  if (!draggedPath) {
    return { ok: false, reason: `no element with vleId="${draggedVleId}" found — reload and retry.` };
  }
  if (!targetPath) {
    return { ok: false, reason: `no element with vleId="${targetVleId}" found — reload and retry.` };
  }
  if (draggedPath.node === targetPath.node) {
    return { ok: false, reason: "can't drop an element onto itself." };
  }

  if (!(draggedPath.parentPath.isJSXElement() || draggedPath.parentPath.isJSXFragment())) {
    return {
      ok: false,
      reason: "this element isn't a literal JSX child in the source (likely rendered via .map()/a conditional) — reordering the underlying data isn't supported yet.",
    };
  }
  if (draggedPath.parentPath.node !== targetPath.parentPath.node) {
    return { ok: false, reason: "dragged and target elements have different parents — cross-parent reordering isn't supported." };
  }

  const draggedNode = draggedPath.node as t.JSXElement;
  const targetNode = targetPath.node as t.JSXElement;
  const children = draggedPath.parentPath.node.children as t.Node[];
  const draggedIdx = children.indexOf(draggedNode);
  const targetIdx = children.indexOf(targetNode);

  if (draggedNode.start == null || draggedNode.end == null || targetNode.start == null || targetNode.end == null) {
    return { ok: false, reason: "couldn't locate element positions." };
  }

  // Remove the dragged node plus one immediately-preceding whitespace-only
  // JSXText sibling (its indentation), so no blank gap is left behind.
  const draggedPrevSibling = draggedIdx > 0 ? children[draggedIdx - 1] : null;
  const removeStart = isWhitespaceOnlyText(draggedPrevSibling) && draggedPrevSibling.start != null
    ? draggedPrevSibling.start
    : draggedNode.start;
  const removeEnd = draggedNode.end;
  const draggedText = source.slice(draggedNode.start, draggedNode.end);

  // Reuse whichever whitespace/indentation already touches the target as
  // the separator template — falls back to a bare newline if siblings sit
  // on one line with no whitespace between them.
  const targetPrevSibling = targetIdx > 0 ? children[targetIdx - 1] : null;
  const targetNextSibling = targetIdx < children.length - 1 ? children[targetIdx + 1] : null;
  const wsTemplate =
    (isWhitespaceOnlyText(targetPrevSibling) && targetPrevSibling.value) ||
    (isWhitespaceOnlyText(targetNextSibling) && targetNextSibling.value) ||
    "\n";

  const insertPos = position === "before" ? targetNode.start : targetNode.end;
  const insertText = position === "before" ? draggedText + wsTemplate : wsTemplate + draggedText;

  let replaced: string;
  if (insertPos <= removeStart) {
    replaced = source.slice(0, insertPos) + insertText + source.slice(insertPos, removeStart) + source.slice(removeEnd);
  } else {
    replaced = source.slice(0, removeStart) + source.slice(removeEnd, insertPos) + insertText + source.slice(insertPos);
  }

  fs.writeFileSync(absPath, replaced, "utf8");
  return { ok: true };
}

/**
 * Removes a whole JSX element (plus one adjacent leading whitespace-only
 * JSXText, same as applyReorder's removal step, so no blank gap is left).
 * Same .map()/conditional refusal as applyReorder, for the same reason:
 * "deleting" a `.map()`-rendered item would delete the shared template
 * (all N instances), not just one — that's a data-array edit, not this.
 */
function applyDelete(
  absPath: string,
  source: string,
  ast: ReturnType<typeof parser.parse>,
  openingTag: t.JSXOpeningElement
): PatchResult {
  let elementPath: any = null;
  traverse(ast, {
    JSXElement(nodePath: any) {
      if (nodePath.node.openingElement === openingTag) {
        elementPath = nodePath;
      }
    },
  });
  if (!elementPath) {
    return { ok: false, reason: "couldn't locate the parent JsxElement for this opening tag." };
  }

  if (!(elementPath.parentPath.isJSXElement() || elementPath.parentPath.isJSXFragment())) {
    return {
      ok: false,
      reason: "this element isn't a literal JSX child in the source (likely rendered via .map()/a conditional) — deleting the underlying data isn't supported yet.",
    };
  }

  const node = elementPath.node as t.JSXElement;
  if (node.start == null || node.end == null) {
    return { ok: false, reason: "couldn't locate element position." };
  }

  const children = elementPath.parentPath.node.children as t.Node[];
  const idx = children.indexOf(node);
  const prevSibling = idx > 0 ? children[idx - 1] : null;
  const removeStart = isWhitespaceOnlyText(prevSibling) && prevSibling.start != null ? prevSibling.start : node.start;

  const replaced = source.slice(0, removeStart) + source.slice(node.end);
  fs.writeFileSync(absPath, replaced, "utf8");
  return { ok: true };
}

/**
 * Returns an edit that ensures `import { importName } from "importFrom"`
 * exists: merges into an existing same-source named import, or — if
 * there's no import from that source at all — a whole new import
 * statement after the last existing one (or at the top of the file if
 * there are none). Returns null if the name is already imported (nothing
 * to do). Deliberately narrow: only understands named imports
 * (`import { A, B } from "X"`) — the only shape components/ui/index.ts's
 * barrel ever needs a consumer to write.
 */
function buildImportEdit(
  ast: ReturnType<typeof parser.parse>,
  importName: string,
  importFrom: string
): { start: number; end: number; text: string } | null {
  let existing: t.ImportDeclaration | null = null;
  let lastImportEnd: number | null = null;

  for (const node of ast.program.body) {
    if (!t.isImportDeclaration(node)) continue;
    if (node.end != null) lastImportEnd = node.end;
    if (node.source.value === importFrom) existing = node;
  }

  if (existing) {
    const alreadyImported = existing.specifiers.some(
      (s) => t.isImportSpecifier(s) && t.isIdentifier(s.imported) && s.imported.name === importName
    );
    if (alreadyImported) return null;

    const lastSpecifier = existing.specifiers[existing.specifiers.length - 1];
    if (!lastSpecifier || lastSpecifier.end == null) return null;
    return { start: lastSpecifier.end, end: lastSpecifier.end, text: `, ${importName}` };
  }

  const insertAt = lastImportEnd ?? 0;
  return { start: insertAt, end: insertAt, text: `\nimport { ${importName} } from "${importFrom}";` };
}

/**
 * Inserts a brand-new JSX element as a sibling of an existing one —
 * backs the design-system palette's drag-and-drop. Same target-validity
 * guard as applyReorder/applyDelete (must be a literal JSX child, not
 * .map()-rendered) and the same whitespace-template-borrowing trick so the
 * new element lands with matching indentation instead of on one line.
 * Optionally also ensures the component's import exists (buildImportEdit).
 * The import edit and the element-insertion edit are computed against the
 * ORIGINAL source and applied in descending start-offset order — the
 * import always sits earlier in the file, so applying the later edit
 * (the element) first means the import edit's own position, computed
 * against the *original* string, is still correct when it's applied second.
 */
function applyInsert(
  absPath: string,
  source: string,
  ast: ReturnType<typeof parser.parse>,
  relPath: string,
  targetVleId: string,
  position: "before" | "after",
  elementSnippet: string,
  importName?: string,
  importFrom?: string
): PatchResult {
  let targetPath: any = null;
  traverse(ast, {
    JSXElement(nodePath: any) {
      if (targetPath) return;
      const opening = nodePath.node.openingElement as t.JSXOpeningElement;
      if (computeVleId(relPath, opening.start) === targetVleId) targetPath = nodePath;
    },
  });

  if (!targetPath) {
    return { ok: false, reason: `no element with vleId="${targetVleId}" found — reload and retry.` };
  }
  if (!(targetPath.parentPath.isJSXElement() || targetPath.parentPath.isJSXFragment())) {
    return {
      ok: false,
      reason: "this element isn't a literal JSX child in the source (likely rendered via .map()/a conditional) — dropping next to it isn't supported yet.",
    };
  }

  const targetNode = targetPath.node as t.JSXElement;
  const children = targetPath.parentPath.node.children as t.Node[];
  const targetIdx = children.indexOf(targetNode);
  if (targetNode.start == null || targetNode.end == null) {
    return { ok: false, reason: "couldn't locate the target element's position." };
  }

  const targetPrevSibling = targetIdx > 0 ? children[targetIdx - 1] : null;
  const targetNextSibling = targetIdx < children.length - 1 ? children[targetIdx + 1] : null;
  const wsTemplate =
    (isWhitespaceOnlyText(targetPrevSibling) && targetPrevSibling.value) ||
    (isWhitespaceOnlyText(targetNextSibling) && targetNextSibling.value) ||
    "\n";

  const insertPos = position === "before" ? targetNode.start : targetNode.end;
  const insertText = position === "before" ? elementSnippet + wsTemplate : wsTemplate + elementSnippet;

  const edits: Array<{ start: number; end: number; text: string }> = [{ start: insertPos, end: insertPos, text: insertText }];
  if (importName && importFrom) {
    const importEdit = buildImportEdit(ast, importName, importFrom);
    if (importEdit) edits.push(importEdit);
  }

  edits.sort((a, b) => b.start - a.start);
  let result = source;
  for (const e of edits) {
    result = result.slice(0, e.start) + e.text + result.slice(e.end);
  }

  fs.writeFileSync(absPath, result, "utf8");
  return { ok: true };
}
