/**
 * Dev-only webpack loader (enforce: "pre", wired in next.config.mjs, only
 * when dev === true — see the loader registration for the exact gating).
 * Runs before Next's own SWC transform, so it always sees real,
 * un-compiled JSX. The actual instrumentation logic lives in
 * instrumentJsx.ts, shared with any other bundler adapter (e.g. the Vite
 * plugin) — this file is just the webpack-loader-shaped wrapper around it.
 */
const path = require("node:path");
const { instrumentJsx } = require("./instrumentJsx");

module.exports = function visualEditorLoader(source) {
  const callback = this.async();
  const relPath = path.relative(this.rootContext, this.resourcePath).split(path.sep).join("/");

  const result = instrumentJsx(source, relPath);
  if (!result) {
    // Unparseable as JSX/TS shouldn't happen for .tsx/.jsx under app/components —
    // pass through untouched rather than break the build over an instrumentation failure.
    callback(null, source);
    return;
  }
  callback(null, result.code, result.map);
};
