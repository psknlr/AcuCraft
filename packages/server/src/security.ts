/**
 * The workspace server's security policy — ClinicalCraft's own (`@clinicalcraft/server` security.ts), cut to a
 * server with no cross-origin callers:
 *
 * - **Binding** — 127.0.0.1 by default; a non-loopback bind requires a token.
 * - **Auth** — with a token, every route but the app's static files needs it: `Authorization: Bearer <token>`,
 *   `?token=<token>`, or the `acu_token` cookie (HttpOnly, SameSite=Strict), which a page visit with a valid
 *   `?token=` sets before it is redirected to the same URL without it (the token leaves the address bar and
 *   history). An MCP client sends it as a Bearer header.
 * - **DNS rebinding** — a loopback-only server accepts only loopback `Host` headers.
 * - **Origins** — same origin only: a request with any other `Origin` is refused (403). With the JSON-only bodies
 *   this also stops a cross-site page posting to the API with the operator's cookie.
 * - **Headers** — nosniff, no-referrer, frame-ancestors none, and a CSP that allows the app's own scripts, styles
 *   and connections only.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** The cookie that carries the access token after a `?token=` visit. */
export const TOKEN_COOKIE = "acu_token";

/** Whether `host` (a bind address, or a hostname without its port) is a loopback name. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(h) || h === "::ffff:127.0.0.1";
}

/** The hostname of a `Host` header (`[::1]:8787` → `::1`, `localhost:8787` → `localhost`). */
export function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : h;
  }
  const colon = h.lastIndexOf(":");
  return colon > 0 && h.indexOf(":") === colon ? h.slice(0, colon) : h;
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** A `Cookie` header as a map (the first value of a name wins). */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || out.has(name)) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep it raw */
    }
    out.set(name, value);
  }
  return out;
}

/** Where a valid token came from, or none. */
export type TokenSource = "header" | "query" | "cookie" | null;

/** The request's token (Bearer header, `?token=`, cookie) against `token`. */
export function tokenSource(req: IncomingMessage, url: URL, token: string): TokenSource {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && safeEqual(m[1]!.trim(), token)) return "header";
  }
  const query = url.searchParams.get("token");
  if (query !== null && safeEqual(query, token)) return "query";
  const cookie = parseCookies(req.headers.cookie).get(TOKEN_COOKIE);
  if (cookie !== undefined && safeEqual(cookie, token)) return "cookie";
  return null;
}

/** The `Set-Cookie` value for the access token. */
export function tokenCookie(token: string): string {
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
}

/** The request's `Origin`: none (a navigation, curl, an MCP client), the server's own, or another (refused). */
export function originOf(req: IncomingMessage): "none" | "same" | "other" {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin === "" || origin === "null") return origin === "null" ? "other" : "none";
  const host = req.headers.host;
  return typeof host === "string" && host && (origin === `http://${host}` || origin === `https://${host}`) ? "same" : "other";
}

/** The Content-Security-Policy of the app: its own scripts, styles and connections, nothing inline, no frames. */
export const APP_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // (a model's embedded textures are read through blob: addresses the page makes itself — fetched, then drawn)
  "img-src 'self' data: blob:",
  "connect-src 'self' blob:",
].join("; ");

/** The debrief page (`encounterHtml`): a self-contained page with its own inline styles and no script at all. */
export const DEBRIEF_CSP = ["default-src 'none'", "style-src 'unsafe-inline'", "img-src data:", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"].join("; ");

/** Headers sent with every response. */
export function securityHeaders(csp: string = APP_CSP): Record<string, string> {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "content-security-policy": csp,
  };
}
