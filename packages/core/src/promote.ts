/**
 * "Promote to main repo" — for the "Keeping VLE fully local" setup (see
 * README), where VLE runs inside a dedicated `local/*` branch's own git
 * worktree (config.repoRoot) and click-to-edit patches land there, never
 * in the developer's real checkout (config.mainRepoRoot). This is a plain
 * git diff/apply, deliberately not agent-mediated — there's nothing
 * ambiguous about "take my current uncommitted changes and apply them
 * somewhere else" that would benefit from an LLM in the loop, only cost
 * and latency it would add.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { VleConfig } from "./config";

export interface PromoteDiff {
  diffText: string;
  diffStat: string;
}

/**
 * Non-destructively snapshots `repoRoot`'s current uncommitted state
 * (tracked edits + brand-new files) as a single diff. Same add/diff
 * technique chatRunner.ts's finalizeTurn and agentRunner.ts's finishJob
 * already use to make untracked files show up in a diff — but unlike
 * those (disposable worktrees VLE itself owns), `repoRoot` here is the
 * developer's own live working checkout, so the temporary `git add -A`
 * is always unstaged again right after, in a `finally`, leaving their
 * working tree exactly as they left it regardless of what happens above.
 */
function snapshotDiff(repoRoot: string): PromoteDiff {
  execFileSync("git", ["add", "-A"], { cwd: repoRoot, stdio: "pipe" });
  try {
    const diffText = execFileSync("git", ["diff", "--cached", "--binary"], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 64 }).toString("utf8");
    const diffStat = execFileSync("git", ["diff", "--cached", "--stat"], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 64 }).toString("utf8");
    return { diffText, diffStat };
  } finally {
    execFileSync("git", ["reset"], { cwd: repoRoot, stdio: "pipe" });
  }
}

function validateMainRepoRoot(config: VleConfig): { ok: true } | { ok: false; reason: string } {
  if (!config.mainRepoRoot) return { ok: false, reason: "mainRepoRoot is not configured" };
  if (path.resolve(config.mainRepoRoot) === path.resolve(config.repoRoot)) {
    return { ok: false, reason: "mainRepoRoot is the same as repoRoot — nothing to promote to" };
  }
  if (!fs.existsSync(path.join(config.mainRepoRoot, ".git"))) {
    return { ok: false, reason: `mainRepoRoot (${config.mainRepoRoot}) doesn't look like a git repo` };
  }
  return { ok: true };
}

/** Read-only preview for the Promote panel — computes the diff without touching anything. */
export function getPromoteDiff(config: VleConfig): { ok: true; diffText: string; diffStat: string } | { ok: false; reason: string } {
  const valid = validateMainRepoRoot(config);
  if (!valid.ok) return valid;
  try {
    const { diffText, diffStat } = snapshotDiff(config.repoRoot);
    return { ok: true, diffText, diffStat };
  } catch (err) {
    return { ok: false, reason: `failed to compute diff: ${(err as Error).message}` };
  }
}

export function promoteToMainRepo(config: VleConfig): { ok: true; diffStat: string } | { ok: false; reason: string } {
  const valid = validateMainRepoRoot(config);
  if (!valid.ok) return valid;

  let diff: PromoteDiff;
  try {
    diff = snapshotDiff(config.repoRoot);
  } catch (err) {
    return { ok: false, reason: `failed to compute diff: ${(err as Error).message}` };
  }
  if (!diff.diffText.trim()) return { ok: false, reason: "no changes to promote" };

  const patchFile = path.join(os.tmpdir(), `vle-promote-${randomUUID()}.patch`);
  fs.writeFileSync(patchFile, diff.diffText, "utf8");

  try {
    execFileSync("git", ["apply", "--check", patchFile], { cwd: config.mainRepoRoot, stdio: "pipe" });
    execFileSync("git", ["apply", patchFile], { cwd: config.mainRepoRoot, stdio: "pipe" });
  } catch (err) {
    fs.rmSync(patchFile, { force: true });
    return { ok: false, reason: `patch didn't apply cleanly to mainRepoRoot: ${(err as Error).message}` };
  }

  // Best-effort: clear exactly what was just promoted out of the source
  // worktree (reverse-applying the identical patch), so it isn't left
  // sitting there to be double-promoted later. Never git checkout/reset
  // --hard here — that would touch anything else the developer has in
  // progress, not just what this patch covers. If the reverse-apply
  // fails, the important part (landing in mainRepoRoot) already
  // succeeded — leave the source dirty rather than fail the whole thing.
  try {
    execFileSync("git", ["apply", "-R", patchFile], { cwd: config.repoRoot, stdio: "pipe" });
  } catch {
    // Best-effort.
  }

  fs.rmSync(patchFile, { force: true });
  return { ok: true, diffStat: diff.diffStat };
}
