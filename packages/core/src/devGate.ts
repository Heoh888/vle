/**
 * Next.js Route Handler adapter over the shared devGateCore check — kept
 * at this same export path/name for backward compatibility with existing
 * `app/api/vle/*` route templates. See devGateCore.ts for the actual
 * dev-only/localhost-only logic; this file only adapts it to
 * NextRequest/NextResponse.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkDevGate } from "./devGateCore";

/** Returns a response to short-circuit with, or null if the request may proceed. */
export function devGate(req: NextRequest): NextResponse | null {
  const result = checkDevGate(req.headers.get("host"));
  if (result.ok) return null;
  return NextResponse.json({ error: result.error }, { status: result.status });
}
