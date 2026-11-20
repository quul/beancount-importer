import { BlockList, isIP } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import type { Request } from "express";

/** A native dialog can only serve a browser running on the same computer. */
export function isLocalRequest(req: Request): boolean {
  const host = req.get("host") ?? "";
  if (!/^(?:[a-z\d.-]+|\[[a-f\d:.]+\])(?::\d+)?$/i.test(host)) return false;
  const origin = req.get("origin");
  const fetchSite = req.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;

  let page: URL;
  try {
    const scheme = origin?.startsWith("https://") ? "https" : "http";
    page = new URL(`${scheme}://${host}`);
  } catch {
    return false;
  }
  if (origin !== undefined && origin !== page.origin) return false;

  const addresses = new BlockList();
  addresses.addSubnet("127.0.0.0", 8);
  addresses.addAddress("::1", "ipv6");
  for (const { address, family } of Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])) {
    addresses.addAddress(address.split("%")[0], family === "IPv6" ? "ipv6" : "ipv4");
  }
  const isLocalAddress = (address: string) => {
    const ip = address.replace(/^\[|\]$/g, "").split("%")[0];
    const family = isIP(ip);
    return family !== 0 && addresses.check(ip, family === 6 ? "ipv6" : "ipv4");
  };
  const name = page.hostname.toLowerCase().replace(/\.$/, "");
  const localHost = name === "localhost" || name.endsWith(".localhost") || name === hostname().toLowerCase() || isLocalAddress(name);
  const forwarded = req.get("x-forwarded-for")?.split(",").map((address) => address.trim()) ?? [];
  // Vite appends the actual client address, so a forwarded hop must also be local.
  return localHost && isLocalAddress(req.socket.remoteAddress ?? "") && forwarded.every(isLocalAddress);
}
