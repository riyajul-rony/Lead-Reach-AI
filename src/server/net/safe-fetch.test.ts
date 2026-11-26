import http from "node:http";
import dns from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "undici";
import { isPrivateIp, safeFetch } from "./safe-fetch";

const activeServers: http.Server[] = [];

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  activeServers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("SSRF safeFetch guard", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    while (activeServers.length > 0) {
      const s = activeServers.pop()!;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it("blocks local and loopback IPv4/IPv6 addresses", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("127.255.0.1")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isPrivateIp("::")).toBe(true);
    expect(isPrivateIp("0.0.0.0")).toBe(true);
    expect(isPrivateIp("localhost")).toBe(true);
    expect(isPrivateIp("sub.localhost")).toBe(true);
  });

  it("blocks AWS/GCP cloud metadata IP and IPv6 link-local / ULA / IPv4-mapped ranges", () => {
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("169.254.1.1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("fe80::1%eth0")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fd12:3456:789a::1")).toBe(true);
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:7f00:1")).toBe(true);
  });

  it("blocks standard RFC1918 and CGNAT IPv4 subnets", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("172.16.0.5")).toBe(true);
    expect(isPrivateIp("172.31.255.254")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("100.64.0.1")).toBe(true);
  });

  it("permits genuine public IPv4 and IPv6 addresses", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("142.250.190.46")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
  });

  it("blocks DNS rebinding at connect time when domain resolves to private/loopback IP", async () => {
    const closeSpy = vi.spyOn(Agent.prototype, "close");

    // Simulate attacker DNS returning a loopback/metadata IP at socket connect time
    const lookupSpy = vi
      .spyOn(dns, "lookup")
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as any);

    await expect(safeFetch("http://rebind.attacker.test/")).rejects.toThrow(/SSRF blocked/i);
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalled();

    closeSpy.mockClear();

    // Also block multi-record DNS rebinding if ANY record is private (e.g. public + metadata IP)
    lookupSpy.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ] as any);

    await expect(safeFetch("http://split-dns.attacker.test/")).rejects.toThrow(/SSRF blocked/i);
    expect(closeSpy).toHaveBeenCalled();
  });

  it("blocks IPv6 private/metadata DNS resolution and closes Agent cleanly", async () => {
    const closeSpy = vi.spyOn(Agent.prototype, "close");
    vi.spyOn(dns, "lookup").mockResolvedValueOnce([
      { address: "fd00:ec2::254", family: 6 },
    ] as any);

    await expect(safeFetch("http://ipv6-ula.attacker.test/")).rejects.toThrow(/SSRF blocked/i);
    expect(closeSpy).toHaveBeenCalled();
  });

  it("re-validates redirects and blocks redirect to private or metadata IP", async () => {
    const closeSpy = vi.spyOn(Agent.prototype, "close");
    const srv = await startServer((req, res) => {
      if (req.url === "/start") {
        res.statusCode = 302;
        res.setHeader("Location", "http://169.254.169.254/latest/meta-data/");
        res.end();
        return;
      }
      if (req.url === "/hop1") {
        res.statusCode = 302;
        res.setHeader("Location", "/final");
        res.end();
        return;
      }
      if (req.url === "/final") {
        res.statusCode = 200;
        res.end("<html>ok</html>");
        return;
      }
      res.statusCode = 302;
      res.setHeader("Location", "http://10.0.0.1/admin");
      res.end();
    });

    // Redirect to metadata IP must be blocked even when initial loopback hop is allowed in test
    await expect(
      safeFetch(`${srv.url}/start`, { allowLoopback: true })
    ).rejects.toThrow(/SSRF blocked/i);

    // Redirect to RFC1918 IP must also be blocked
    await expect(
      safeFetch(`${srv.url}/other`, { allowLoopback: true })
    ).rejects.toThrow(/SSRF blocked/i);

    // Legitimate same-origin redirect succeeds and closes per-hop agents
    const html = await safeFetch(`${srv.url}/hop1`, { allowLoopback: true });
    expect(html).toBe("<html>ok</html>");
    expect(closeSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("enforces maxRedirects limit", async () => {
    const srv = await startServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", "/loop");
      res.end();
    });

    await expect(
      safeFetch(`${srv.url}/loop`, { allowLoopback: true, maxRedirects: 2 })
    ).rejects.toThrow(/Too many redirects/i);
  });
});
