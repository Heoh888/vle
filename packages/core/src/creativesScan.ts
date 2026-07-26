/**
 * Scans VleConfig.creativesDir for agent-generated (or manually dropped)
 * image/video assets, for the Creatives panel — the counterpart to
 * designSystemScan.ts, but for media instead of components. No manual
 * curation: whatever's a file in that directory IS the list.
 */
import fs from "node:fs";
import path from "node:path";
import type { VleConfig } from "./config";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"];
const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov"];

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

export interface CreativeAsset {
  name: string;
  type: "image" | "video" | "other";
  size: number;
  mtimeMs: number;
}

function assetType(ext: string): CreativeAsset["type"] {
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  return "other";
}

export function scanCreatives(config: VleConfig): CreativeAsset[] {
  const dir = path.join(config.projectRoot, config.creativesDir);
  if (!fs.existsSync(dir)) return [];

  const assets: CreativeAsset[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const stat = fs.statSync(path.join(dir, entry.name));
    assets.push({ name: entry.name, type: assetType(path.extname(entry.name).toLowerCase()), size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return assets.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Resolves `name` strictly inside creativesDir — rejects path traversal, same discipline as patch.ts's resolveProjectFile. Returns the absolute path and its mime type, or null if it doesn't exist / escapes the directory. */
export function resolveCreativeFile(config: VleConfig, name: string): { absPath: string; mimeType: string } | null {
  const dir = path.join(config.projectRoot, config.creativesDir);
  const abs = path.resolve(dir, name);
  const dirWithSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
  if (!abs.startsWith(dirWithSep)) return null;
  if (!fs.existsSync(abs)) return null;
  const mimeType = MIME_TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
  return { absPath: abs, mimeType };
}

export type CopyToPublicResult = { ok: true; publicPath: string } | { ok: false; reason: string };

/**
 * Copies a creative from creativesDir into publicDir so it becomes a real,
 * permanent static asset — `/name` — rather than something only reachable
 * through a dev-only VLE endpoint that 404s in production. Called right
 * before wiring a creative into the page (see patch.ts's plain "insert"
 * kind, reused unchanged once this returns the public-facing path).
 * Overwrites an existing file of the same name at the destination — same
 * "last drop wins" semantics as saving over a file in a normal editor.
 */
export function copyCreativeToPublic(config: VleConfig, name: string): CopyToPublicResult {
  const resolved = resolveCreativeFile(config, name);
  if (!resolved) return { ok: false, reason: `creative not found: ${name}` };

  const publicDir = path.join(config.projectRoot, config.publicDir);
  const dest = path.join(publicDir, name);
  const publicDirWithSep = publicDir.endsWith(path.sep) ? publicDir : publicDir + path.sep;
  if (!dest.startsWith(publicDirWithSep)) return { ok: false, reason: "invalid creative name" };

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(resolved.absPath, dest);
  } catch (err) {
    return { ok: false, reason: `failed to copy into ${config.publicDir}: ${(err as Error).message}` };
  }

  return { ok: true, publicPath: `/${name}` };
}
