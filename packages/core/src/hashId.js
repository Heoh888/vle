const crypto = require("node:crypto");

/**
 * Single source of truth for the vle-id hash — must stay byte-identical
 * between babel-loader.js (injects the hash into the in-memory bundle so
 * the browser can see it) and patch.ts (independently re-parses the real
 * file on disk with the same algorithm to find the same node — the
 * attribute itself was never written to disk, only computed transiently by
 * the loader, so this recomputation is the only way to relocate it).
 */
function computeVleId(relPath, nodeStart) {
  return crypto.createHash("sha1").update(`${relPath}:${nodeStart}`).digest("hex").slice(0, 12);
}

module.exports = { computeVleId };
