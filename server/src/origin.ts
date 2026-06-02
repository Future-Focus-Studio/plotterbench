// Loopback-origin check shared by the CORS middleware and the WebSocket
// verifyClient gate. Extracted from index.ts so it can be unit-tested without
// starting the HTTP server.

// Treat only loopback origins as trusted. The dev UI runs on :49173 and the
// prod UI is served same-origin on :49787; both resolve to one of these hosts.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * True if `origin` points at the local machine: a bare loopback host, or any
 * *.localhost subdomain. The .localhost TLD is reserved (RFC 6761) and always
 * resolves to loopback, so reverse-proxy setups like http://plotterbench.localhost
 * are just as local as localhost itself.
 */
export function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return LOCAL_HOSTS.has(hostname) || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}
