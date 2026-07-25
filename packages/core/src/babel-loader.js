/**
 * Dev-only webpack loader (enforce: "pre", wired in next.config.mjs, only
 * when dev === true — see the loader registration for the exact gating).
 *
 * Injects data-vle-id (stable hash of file+source-position, NOT random —
 * has to survive re-renders/HMR so the overlay's currently-open panel
 * doesn't go stale) and data-vle-loc (human-readable file:line:col) onto
 * every literal JSX opening tag. Purely additive — doesn't touch anything
 * else in the file. Runs before Next's own SWC transform (enforce: "pre"),
 * so it always sees real, un-compiled JSX.
 */
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");
const path = require("node:path");
const { computeVleId } = require("./hashId.js");

module.exports = function visualEditorLoader(source) {
  const callback = this.async();
  const relPath = path.relative(this.rootContext, this.resourcePath).split(path.sep).join("/");

  let ast;
  try {
    ast = parser.parse(source, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    });
  } catch (err) {
    // Unparseable as JSX/TS shouldn't happen for .tsx/.jsx under app/components —
    // pass through untouched rather than break the build over an instrumentation failure.
    callback(null, source);
    return;
  }

  traverse(ast, {
    JSXOpeningElement(nodePath) {
      const node = nodePath.node;
      if (!node.loc) return;
      const { line, column } = node.loc.start;
      const hash = computeVleId(relPath, node.start);

      const hasAttr = (name) => node.attributes.some((a) => t.isJSXAttribute(a) && a.name.name === name);

      if (!hasAttr("data-vle-id")) {
        node.attributes.push(t.jsxAttribute(t.jsxIdentifier("data-vle-id"), t.stringLiteral(hash)));
      }
      if (!hasAttr("data-vle-loc")) {
        node.attributes.push(
          t.jsxAttribute(t.jsxIdentifier("data-vle-loc"), t.stringLiteral(`${relPath}:${line}:${column}`))
        );
      }

      // Same "is this a literal JSX child, not .map()/conditional-rendered"
      // check patch.ts's applyReorder/applyInsert already make server-side
      // before allowing a structural edit — computed here too so the client
      // can warn *during* a drag (see VisualEditorOverlay.tsx's dragover
      // handler), before a doomed drop attempt round-trips to the server.
      // A root-of-return element (no JSX parent at all) also gets flagged —
      // correctly, since it's refused server-side for the same reason.
      const jsxElementPath = nodePath.parentPath; // JSXOpeningElement's parent is always its own JSXElement
      const grandparent = jsxElementPath && jsxElementPath.parentPath;
      const isLiteralChild = !!grandparent && (grandparent.isJSXElement() || grandparent.isJSXFragment());
      if (!isLiteralChild && !hasAttr("data-vle-nonliteral")) {
        node.attributes.push(t.jsxAttribute(t.jsxIdentifier("data-vle-nonliteral"), t.stringLiteral("true")));
      }
    },
  });

  const output = generate(ast, { retainLines: false, sourceMaps: true, sourceFileName: relPath }, source);
  callback(null, output.code, output.map);
};
