// The dev server (npm run dev) proxies the board API to a board server on
// its usual port. Kept apart from vite.config.ts so it can be tested.

export const BOARD_SERVER = 'http://127.0.0.1:4777';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The Origin header to forward for a request that came through the dev
 * server. The board server only accepts its own origin, so a request from
 * the Vite dev page (served from `devHost` on this machine) is passed on as
 * coming from the board server. Any other origin (another website) is
 * forwarded unchanged, so the board server's Origin check still turns it away.
 */
export function proxiedOrigin(origin: string | undefined, devHost: string | undefined): string | undefined {
  if (!origin || !devHost) return origin;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return origin;
  }
  const fromDevPage = url.protocol === 'http:' && url.host === devHost.toLowerCase() && LOOPBACK.has(url.hostname);
  return fromDevPage ? BOARD_SERVER : origin;
}
