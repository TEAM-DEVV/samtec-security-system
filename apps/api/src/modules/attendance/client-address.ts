import type { Request } from 'express';

/**
 * The network address the request really came from, as the **hosting
 * platform** reports it — never a header the kiosk could set itself
 * (docs/plan/13-biometrics-design.md section 3, "Network address").
 *
 * Every clock-in attempt records it. It is what tells an ADMIN that fifty
 * refused attempts came from one machine somewhere rather than from the
 * kiosk in the guard hut, and Phase 5's rules read it. The retention sweep
 * clears it 90 days after a worker leaves, because on its own it describes
 * a person rather than their attendance.
 *
 * **Why not `request.ip`.** Express only believes `X-Forwarded-For` when the
 * app sets `trust proxy`, which this one deliberately does not: trusting it
 * everywhere would let anyone who can reach the API write whatever address
 * they liked. Instead this reads the header **Vercel itself writes** and
 * overwrites on every request — `x-vercel-forwarded-for` — and falls back to
 * the socket's own address when the API runs anywhere else (a laptop, a
 * test, a container). A kiosk that sets `x-forwarded-for` by hand changes
 * nothing.
 *
 * Returns `null` rather than a guess when there is nothing trustworthy to
 * record: the column is nullable, and a made-up address is worse than none.
 */
export function clientAddress(request: Request): string | null {
  const fromPlatform = firstAddress(request.headers['x-vercel-forwarded-for']);
  if (fromPlatform) {
    return fromPlatform;
  }
  // Not on Vercel: the socket is the real peer, with no proxy in between.
  return cleanAddress(request.socket.remoteAddress ?? '');
}

/** A forwarding header may carry a list; the first entry is the original caller. */
function firstAddress(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  return cleanAddress((raw ?? '').split(',')[0] ?? '');
}

/**
 * PostgreSQL's `inet` type refuses anything that is not an address, so a
 * value that does not look like one is dropped rather than written. IPv4
 * addresses arriving in IPv6 clothing (`::ffff:1.2.3.4`, which is what a
 * dual-stack socket reports) are unwrapped to the address people recognise.
 */
function cleanAddress(value: string): string | null {
  const trimmed = value.trim().replace(/^\[|\]$/g, '');
  if (trimmed.length === 0 || trimmed.length > 45) {
    return null;
  }
  const unwrapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  const address = unwrapped?.[1] ?? trimmed;
  return looksLikeAddress(address) ? address : null;
}

function looksLikeAddress(value: string): boolean {
  const asIpv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (asIpv4) {
    return asIpv4.slice(1).every((part) => Number(part) <= 255 && !/^0\d/.test(part));
  }
  // IPv6: hex groups and colons only, and at least one colon.
  return /^[0-9a-f:]+$/i.test(value) && value.includes(':');
}
