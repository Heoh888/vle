/**
 * Framework-agnostic core of the security gate every VLE endpoint needs:
 * dev-only, localhost-only — these endpoints write directly to source
 * files on disk. Takes just the Host header value so any transport
 * (Next.js Route Handlers, a Vite dev-server middleware, a plain Node
 * http server) can reuse the same check without depending on that
 * transport's request/response types.
 */
export type DevGateResult = { ok: true } | { ok: false; status: number; error: string };

function isLocalhost(host: string): boolean {
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:") || host === "localhost" || host === "127.0.0.1";
}

export function checkDevGate(hostHeader: string | null | undefined): DevGateResult {
  if (process.env.NODE_ENV !== "development") {
    return { ok: false, status: 404, error: "not found" };
  }
  if (!isLocalhost(hostHeader ?? "")) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  return { ok: true };
}
