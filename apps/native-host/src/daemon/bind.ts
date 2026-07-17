/**
 * Whether a bind host is loopback. Parses IP literals only — a hostname like
 * `127.0.0.1.evil.example` (which could resolve to a routable address) is NOT
 * loopback, so the non-loopback auth/identity/WS-token guards can't be bypassed
 * by a crafted hostname.
 *
 * Loopback: `localhost`, `::1`, and any 127.0.0.0/8 IPv4 literal. `0.0.0.0` and
 * `::` (all-interfaces) are explicitly NOT loopback.
 */
export function isLoopbackBind(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost") return true;
  if (h === "::1") return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1).map((n) => Number.parseInt(n, 10));
  return octets.every((o) => o <= 255) && octets[0] === 127;
}
