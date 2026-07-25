/**
 * Injects data-vle-id/data-vle-loc/data-vle-nonliteral onto every literal
 * JSX opening tag in `source` — the one piece of build-time instrumentation
 * every bundler adapter (webpack's babel-loader.js, a Vite plugin) needs,
 * kept in exactly one place so the two never drift out of sync.
 *
 * data-vle-id/data-vle-loc: stable hash of file+source-position (NOT
 * random — has to survive re-renders/HMR so the overlay's currently-open
 * panel doesn't go stale) and human-readable file:line:col.
 *
 * data-vle-nonliteral: same "is this a literal JSX child, not
 * .map()/conditional-rendered" check patch.ts's applyReorder/applyInsert
 * already make server-side before allowing a structural edit — computed
 * here too so the client can warn *during* a drag, before a doomed drop
 * attempt round-trips to the server.
 *
 * Purely additive — doesn't touch anything else in the file. Returns null
 * if `source` doesn't parse as JSX/TS — callers should pass the original
 * source through untouched rather than break the build over an
 * instrumentation failure.
 */
import * as parser from "@babel/parser";
import traverseModule from "@babel/traverse";
import generateModule from "@babel/generator";
import * as t from "@babel/types";
import { computeVleId } from "./hashId.js";

const traverse: typeof import("@babel/traverse").default = (traverseModule as any).default ?? (traverseModule as any);
const generate: typeof import("@babel/generator").default = (generateModule as any).default ?? (generateModule as any);

export interface InstrumentResult {
  code: string;
  map: any;
}

export function instrumentJsx(source: string, relPath: string): InstrumentResult | null {
  let ast: ReturnType<typeof parser.parse>;
  try {
    ast = parser.parse(source, { sourceType: "module", plugins: ["jsx", "typescript"] });
  } catch {
    return null;
  }

  traverse(ast, {
    JSXOpeningElement(nodePath: any) {
      const node = nodePath.node as t.JSXOpeningElement;
      if (!node.loc) return;
      const { line, column } = node.loc.start;
      const hash = computeVleId(relPath, node.start);

      const hasAttr = (name: string) => node.attributes.some((a) => t.isJSXAttribute(a) && a.name.name === name);

      if (!hasAttr("data-vle-id")) {
        node.attributes.push(t.jsxAttribute(t.jsxIdentifier("data-vle-id"), t.stringLiteral(hash)));
      }
      if (!hasAttr("data-vle-loc")) {
        node.attributes.push(
          t.jsxAttribute(t.jsxIdentifier("data-vle-loc"), t.stringLiteral(`${relPath}:${line}:${column}`))
        );
      }

      const jsxElementPath = nodePath.parentPath; // JSXOpeningElement's parent is always its own JSXElement
      const grandparent = jsxElementPath && jsxElementPath.parentPath;
      const isLiteralChild = !!grandparent && (grandparent.isJSXElement() || grandparent.isJSXFragment());
      if (!isLiteralChild && !hasAttr("data-vle-nonliteral")) {
        node.attributes.push(t.jsxAttribute(t.jsxIdentifier("data-vle-nonliteral"), t.stringLiteral("true")));
      }
    },
  });

  const output = generate(ast, { retainLines: false, sourceMaps: true, sourceFileName: relPath }, source);
  return { code: output.code, map: output.map };
}
