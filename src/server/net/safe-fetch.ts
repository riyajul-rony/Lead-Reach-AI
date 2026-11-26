import dns from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const MAX_ALLOWED_REDIRECTS = 5;

function stripZoneAndBrackets(raw: string): string {
  let clean = raw.trim().toLowerCase();
  if (clean.startsWith("[") && clean.endsWith("]")) {
    clean = clean.slice(1, -1);
  }
  const zoneIdx = clean.indexOf("%");
  if (zoneIdx !== -1) {
    clean = clean.slice(0, zoneIdx);
  }
  return clean;
}

/**
 * Expands any valid IPv6 address (including :: compression and embedded IPv4)
 * into eight 16-bit integer groups.
 */
function parseIpv6Hextets(ip: string): number[] | null {
  const clean = stripZoneAndBrackets(ip);
  if (!net.isIPv6(clean)) return null;

  const halves = clean.split("::");
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const tokens = side.split(":");
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.includes(".")) {
        if (i !== tokens.length - 1 || !net.isIPv4(token)) return null;
        const octets = token.split(".").map(Number);
        out.push((octets[0] << 8) | octets[1]);
        out.push((octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
        out.push(parseInt(token, 16));
      }
    }
    return out;
  };

  const left = parseSide(halves[0]);
  if (!left) return null;

  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }

  const right = parseSide(halves[1]);
  if (!right) return null;

  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;

  return [...left, ...new Array(missing).fill(0), ...right];
}

function isLoopbackIp(ip: string): boolean {
  const clean = stripZoneAndBrackets(ip);
  if (clean === "127.0.0.1" || clean === "::1") return true;
  if (net.isIPv4(clean)) {
    const firstOctet = Number(clean.split(".")[0]);
    return firstOctet === 127;
  }
  const hextets = parseIpv6Hextets(clean);
  if (hextets) {
    if (hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1) {
      return true;
    }
    if (
      hextets.slice(0, 5).every((h) => h === 0) &&
      hextets[5] === 0xffff &&
      (hextets[6] >> 8) === 127
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Validates if an IP address is a private, loopback, link-local, or cloud metadata address.
 * Prevents Server-Side Request Forgery (SSRF) when crawling target websites.
 */
export function isPrivateIp(ip: string): boolean {
  const clean = stripZoneAndBrackets(ip);
  if (!clean || clean === "localhost" || clean.endsWith(".localhost")) {
    return true;
  }

  const ipVersion = net.isIP(clean);
  if (!ipVersion) return true;

  if (ipVersion === 4) {
    const parts = clean.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8 (unspecified / current network)
    if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a === 127) return true; // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
    if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24
    if (a === 192 && b === 0 && parts[2] === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmark)
    if (a >= 224) return true; // 224.0.0.0/4 multicast & 240.0.0.0/4 reserved
    return false;
  }

  // IPv6 checks
  const hextets = parseIpv6Hextets(clean);
  if (!hextets) return true;

  if (hextets.every((h) => h === 0)) return true; // ::
  if (hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1) return true; // ::1

  // IPv4-mapped IPv6 (::ffff:0:0/96) or IPv4-compatible (::/96)
  if (hextets.slice(0, 5).every((h) => h === 0) && (hextets[5] === 0xffff || hextets[5] === 0)) {
    const mappedIpv4 = [
      (hextets[6] >> 8) & 0xff,
      hextets[6] & 0xff,
      (hextets[7] >> 8) & 0xff,
      hextets[7] & 0xff,
    ].join(".");
    return isPrivateIp(mappedIpv4);
  }

  // Unique Local Addresses fc00::/7 (fc00:: - fdff::)
  if ((hextets[0] & 0xfe00) === 0xfc00) return true;

  // Link-Local fe80::/10 (fe80:: - febf::)
  if ((hextets[0] & 0xffc0) === 0xfe80) return true;

  // Multicast ff00::/8
  if ((hextets[0] & 0xff00) === 0xff00) return true;

  return false;
}

function isAllowedIp(ip: string, allowLoopback: boolean): boolean {
  if (!isPrivateIp(ip)) return true;
  if (allowLoopback && isLoopbackIp(ip)) return true;
  return false;
}

function isBlockedHostnameLiteral(hostname: string, allowLoopback: boolean): boolean {
  const clean = stripZoneAndBrackets(hostname).replace(/\.$/, "");
  if (clean === "localhost" || clean.endsWith(".localhost")) {
    return !allowLoopback;
  }
  if (net.isIP(clean)) {
    return !isAllowedIp(clean, allowLoopback);
  }
  return false;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

/**
 * Resolves DNS at socket connect time, validates every returned IP against SSRF rules,
 * and pins the validated IP directly into undici's TCP/TLS connector so DNS is never re-resolved.
 */
function createPinnedDispatcher(allowLoopback: boolean): Agent {
  const lookup = (
    hostname: string,
    opts: LookupOptions,
    cb: LookupCallback
  ): void => {
    const normalizedHost = stripZoneAndBrackets(hostname);

    if (net.isIP(normalizedHost)) {
      if (!isAllowedIp(normalizedHost, allowLoopback)) {
        cb(
          new Error(`SSRF blocked: Target IP (${normalizedHost}) is private or metadata`),
          ""
        );
        return;
      }
      const family = net.isIPv6(normalizedHost) ? 6 : 4;
      if (opts?.all) {
        cb(null, [{ address: normalizedHost, family }]);
      } else {
        cb(null, normalizedHost, family);
      }
      return;
    }

    if (normalizedHost === "localhost" || normalizedHost.endsWith(".localhost")) {
      if (!allowLoopback) {
        cb(new Error(`SSRF blocked: Hostname (${normalizedHost}) is private`), "");
        return;
      }
      if (opts?.all) {
        cb(null, [{ address: "127.0.0.1", family: 4 }]);
      } else {
        cb(null, "127.0.0.1", 4);
      }
      return;
    }

    dns
      .lookup(normalizedHost, { all: true })
      .then((records) => {
        if (!records || records.length === 0) {
          cb(new Error(`DNS resolution failed for ${normalizedHost}`), "");
          return;
        }

        // Reject if ANY returned A/AAAA record resolves to a private/metadata range
        for (const rec of records) {
          if (!isAllowedIp(rec.address, allowLoopback)) {
            cb(
              new Error(
                `SSRF blocked: Domain resolves to private or metadata IP (${rec.address})`
              ),
              ""
            );
            return;
          }
        }

        const pinned = records[0];
        if (opts?.all) {
          cb(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          cb(null, pinned.address, pinned.family);
        }
      })
      .catch((err: any) => {
        if (err?.message?.includes("SSRF blocked")) {
          cb(err, "");
          return;
        }
        cb(new Error(`DNS resolution failed for ${normalizedHost}`), "");
      });
  };

  return new Agent({
    connect: {
      lookup: lookup as any,
    },
  });
}

async function readResponseWithLimit(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let result = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = maxBytes - totalBytes;
      if (remaining <= 0) {
        await reader.cancel().catch(() => {});
        break;
      }

      if (value.byteLength > remaining) {
        result += decoder.decode(value.subarray(0, remaining), { stream: false });
        totalBytes += remaining;
        await reader.cancel().catch(() => {});
        break;
      }

      result += decoder.decode(value, { stream: true });
      totalBytes += value.byteLength;
    }
    result += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  return result;
}

function isSsrfOrAbortError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || "");
  const causeMsg =
    err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  return (
    msg.includes("SSRF blocked") ||
    causeMsg.includes("SSRF blocked") ||
    msg.includes("DNS resolution failed") ||
    causeMsg.includes("DNS resolution failed") ||
    msg.includes("Unsupported protocol") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

type HopResult =
  | { kind: "redirect"; nextUrl: string }
  | { kind: "body"; text: string };

async function executeSingleHop(
  url: string,
  timeoutMs: number,
  maxBytes: number,
  allowLoopback: boolean
): Promise<HopResult> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  if (isBlockedHostnameLiteral(parsed.hostname, allowLoopback)) {
    throw new Error(
      `SSRF blocked: Host (${parsed.hostname}) resolves to private or metadata IP`
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const agent = createPinnedDispatcher(allowLoopback);

  try {
    let res: Response;
    try {
      res = (await undiciFetch(url, {
        signal: controller.signal,
        headers: DEFAULT_HEADERS,
        redirect: "manual",
        dispatcher: agent as unknown as Dispatcher,
      })) as unknown as Response;
    } catch (err: any) {
      if (err?.cause?.message?.includes("SSRF blocked")) {
        throw new Error(err.cause.message);
      }
      if (err?.cause?.message?.includes("DNS resolution failed")) {
        throw new Error(err.cause.message);
      }
      throw err;
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!location) {
        throw new Error(`Redirect (${res.status}) missing Location header`);
      }
      return { kind: "redirect", nextUrl: new URL(location, url).toString() };
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP error ${res.status}`);
    }

    const text = await readResponseWithLimit(res, maxBytes);
    return { kind: "body", text };
  } finally {
    clearTimeout(timeout);
    await agent.close().catch(() => {});
  }
}

/**
 * Safely fetches a URL with connect-time pinned-IP SSRF protection, strict timeouts,
 * per-hop redirect re-validation, and response size limits.
 */
export async function safeFetch(
  targetUrl: string,
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    allowLoopback?: boolean;
  } = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024; // 2MB limit
  const allowLoopback = options.allowLoopback ?? false;
  const maxRedirects = Math.min(Math.max(0, options.maxRedirects ?? 3), MAX_ALLOWED_REDIRECTS);

  let currentUrl = targetUrl;
  let redirects = 0;

  while (redirects <= maxRedirects) {
    let hopResult: HopResult;
    try {
      hopResult = await executeSingleHop(currentUrl, timeoutMs, maxBytes, allowLoopback);
    } catch (fetchErr: any) {
      if (!isSsrfOrAbortError(fetchErr) && currentUrl.toLowerCase().startsWith("https://")) {
        const httpFallback = currentUrl.replace(/^https:\/\//i, "http://");
        hopResult = await executeSingleHop(httpFallback, timeoutMs, maxBytes, allowLoopback);
      } else {
        throw fetchErr;
      }
    }

    if (hopResult.kind === "redirect") {
      if (redirects >= maxRedirects) {
        throw new Error("Too many redirects");
      }
      currentUrl = hopResult.nextUrl;
      redirects++;
      continue;
    }

    return hopResult.text;
  }

  throw new Error("Too many redirects");
}
