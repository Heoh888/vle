/**
 * Shared security gate for every visual-editor API route — one place to get
 * this right rather than duplicating it per-route. Refuses anything outside
 * NODE_ENV=development, and anything not addressed to localhost: these
 * routes write directly to source files on disk.
 */
import { NextRequest, NextResponse } from "next/server";

function isLocalhost(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:") || host === "localhost" || host === "127.0.0.1";
}

/** Returns a response to short-circuit with, or null if the request may proceed. */
export function devGate(req: NextRequest): NextResponse | null {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!isLocalhost(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return null;
}
