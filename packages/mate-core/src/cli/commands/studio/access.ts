import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Shortest operator-supplied token accepted; a generated one is 43 characters. */
export const MIN_TOKEN_LENGTH = 32;

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

export type StudioInvocation = "interactive" | "serve";

export interface StudioAccessOptions {
  invocation: StudioInvocation;
  terminal: boolean;
  /** Bound interface as passed to the server. */
  hostname: string;
  /** Read at request time: the port is known only once the server has bound. */
  port: () => number;
  allowedHosts?: readonly string[];
  publicOrigin?: string | null;
  token?: string | null;
}

export type StudioRequirement = "none" | "token";

/**
 * One server's Host, Origin, and token policy. `null` token means the server
 * is unguarded and issues none.
 */
export interface StudioAccess {
  invocation: StudioInvocation;
  guarded: boolean;
  token: string | null;
  cookieName(): string;
  /** Accepted origin for this request, or `null` when its Host is not one Studio answers to. */
  acceptedOrigin(request: Request): string | null;
  originMatches(request: Request, acceptedOrigin: string): boolean;
  hasToken(request: Request): boolean;
  /** Whether a request of this kind needs the token under this invocation. */
  requires(kind: "read" | "save" | "terminal"): boolean;
}

export function generateStudioToken(): string {
  return randomBytes(32).toString("base64url");
}

export function validateStudioToken(value: string): string | null {
  if (value.trim().length < MIN_TOKEN_LENGTH) {
    return `the supplied token must be at least ${MIN_TOKEN_LENGTH} characters`;
  }
  return null;
}

/** `null` for anything other than an exact `http(s)://host[:port]` origin. */
export function normalizeOrigin(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || value.endsWith("/")) return null;
  return parsed.origin;
}

/** Lower-cased `host[:port]` with the HTTP default port dropped, or `null` when unparsable. */
export function normalizeAuthority(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[\s/?#@\\]/.test(trimmed)) return null;
  try {
    const parsed = new URL(`http://${trimmed}`);
    return parsed.host;
  } catch {
    return null;
  }
}

function bracketed(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Hashing first keeps the comparison constant-time for inputs of any length. */
export function tokensEqual(candidate: string, expected: string): boolean {
  return timingSafeEqual(digest(candidate), digest(expected));
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function createStudioAccess(options: StudioAccessOptions): StudioAccess {
  const guarded = options.invocation === "serve" || options.terminal;
  const token = guarded ? (options.token ?? generateStudioToken()) : null;
  const publicOrigin = options.publicOrigin ? normalizeOrigin(options.publicOrigin) : null;
  const publicAuthority = publicOrigin ? new URL(publicOrigin).host : null;
  const configured = new Set<string>();
  for (const host of options.allowedHosts ?? []) {
    const authority = normalizeAuthority(host);
    if (authority) configured.add(authority);
  }
  if (publicAuthority) configured.add(publicAuthority);

  const accepted = (): Set<string> => {
    const port = options.port();
    const hosts = new Set(configured);
    for (const hostname of [...LOOPBACK_HOSTNAMES, bracketed(options.hostname)]) {
      const authority = normalizeAuthority(`${hostname}:${port}`);
      if (authority) hosts.add(authority);
    }
    return hosts;
  };

  return {
    invocation: options.invocation,
    guarded,
    token,
    cookieName: () => `mate_studio_${options.port()}`,
    acceptedOrigin(request) {
      const raw = request.headers.get("host") ?? new URL(request.url).host;
      const authority = normalizeAuthority(raw);
      if (!authority || !accepted().has(authority)) return null;
      if (publicOrigin && authority === publicAuthority) return publicOrigin;
      return `http://${authority}`;
    },
    originMatches(request, acceptedOrigin) {
      const origin = request.headers.get("origin");
      if (!origin || origin === "null") return false;
      return normalizeOrigin(origin) === acceptedOrigin;
    },
    hasToken(request) {
      if (!token) return false;
      const value = readCookie(request, `mate_studio_${options.port()}`);
      return value !== null && tokensEqual(value, token);
    },
    requires(kind) {
      if (!guarded) return false;
      if (options.invocation === "serve") return true;
      return kind !== "read";
    },
  };
}

const EXCHANGE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

/**
 * Trades a `?token=` navigation for the cookie and a relative redirect, so the
 * browser never leaves the Host it asked for. `null` when the request carries
 * no token parameter.
 */
export function exchangeStudioToken(
  request: Request,
  access: StudioAccess,
  acceptedOrigin: string,
): Response | null {
  const url = new URL(request.url);
  if (!url.searchParams.has("token")) return null;
  if (request.method !== "GET" || !access.token) {
    return new Response("the access token is exchanged only by opening its address", {
      status: 400,
      headers: EXCHANGE_HEADERS,
    });
  }
  const candidate = url.searchParams.get("token") ?? "";
  if (!tokensEqual(candidate, access.token)) {
    return new Response("the access token does not match; open the address Studio printed", {
      status: 403,
      headers: EXCHANGE_HEADERS,
    });
  }
  url.searchParams.delete("token");
  const secure = acceptedOrigin.startsWith("https:") ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      ...EXCHANGE_HEADERS,
      location: `${url.pathname}${url.search}`,
      "set-cookie": `${access.cookieName()}=${access.token}; Path=/; HttpOnly; SameSite=Strict${secure}`,
    },
  });
}

/** Address the operator opens: loopback for wildcard or loopback binds, carrying the token only when it was generated. */
export function studioAddress(hostname: string, port: number, token: string | null): string {
  const wildcard = hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]";
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
  const host = wildcard || loopback ? "localhost" : bracketed(hostname);
  const base = `http://${host}:${port}`;
  return token ? `${base}/?token=${token}` : base;
}
