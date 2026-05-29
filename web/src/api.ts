export interface PortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  likelyPlotter?: boolean;
}

export interface PlotOptions {
  pageWidthMm: number;
  pageHeightMm: number;
  offsetXMm: number;
  offsetYMm: number;
  svgUnitsToMm: number;
  drawSpeedMmPerSec: number;
  travelSpeedMmPerSec: number;
  penUpDelayMs: number;
  penDownDelayMs: number;
  maxSegmentMm: number;
  penUpZ?: number;
  penDownZ?: number;
  penSpeedMmPerMin?: number;
  flipX?: boolean;
  flipY?: boolean;
  swapXY?: boolean;
  optimizePaths?: boolean;
  reversePaths?: boolean;
  startPolylineIndex?: number;
}

export interface OptimizeStats {
  originalCount: number;
  optimizedCount: number;
  reversed: number;
  merged: number;
  originalTravel: number;
  optimizedTravel: number;
  drawDistance: number;
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export const api = {
  ports: () => req<{ ports: PortInfo[]; connected: boolean }>("/api/ports"),
  connect: (path: string) =>
    req<{ connected: boolean; version: string }>("/api/connect", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  disconnect: () => req<{ connected: false }>("/api/disconnect", { method: "POST" }),
  pen: (state: "up" | "down") =>
    req<{ ok: true }>("/api/pen", { method: "POST", body: JSON.stringify({ state }) }),
  motors: (enable: boolean) =>
    req<{ ok: true }>("/api/motors", { method: "POST", body: JSON.stringify({ enable }) }),
  home: () => req<{ ok: true }>("/api/home", { method: "POST" }),
  setOrigin: () => req<{ ok: true }>("/api/set-origin", { method: "POST" }),
  plot: (svg: string, options: PlotOptions) =>
    req<{ started: true; polylineCount: number }>("/api/plot", {
      method: "POST",
      body: JSON.stringify({ svg, options }),
    }),
  cancel: () => req<{ ok: true }>("/api/cancel", { method: "POST" }),
  pause: () => req<{ ok: true }>("/api/pause", { method: "POST" }),
  resume: () => req<{ ok: true }>("/api/resume", { method: "POST" }),
  optimize: (svg: string) =>
    req<{ stats: OptimizeStats }>("/api/optimize", {
      method: "POST",
      body: JSON.stringify({ svg }),
    }),
  plan: (svg: string, options: PlotOptions) =>
    req<{ polylines: { x: number; y: number }[][] }>("/api/plan", {
      method: "POST",
      body: JSON.stringify({ svg, options }),
    }),
};

export type WsEvent =
  | { type: "hello"; connected: boolean; path?: string | null; version?: string | null }
  | { type: "connection"; connected: boolean; path?: string; version?: string }
  | {
      type: "progress";
      phase: "preparing" | "drawing" | "paused" | "done" | "error" | "cancelled";
      polylineIndex: number;
      polylineCount: number;
      segmentIndex: number;
      segmentCount: number;
      message?: string;
    }
  | {
      type: "plot-start";
      polylines: { x: number; y: number }[][];
      startIndex: number;
    };

export function openWs(onMessage: (e: WsEvent) => void): () => void {
  // In dev, talk directly to the API server on :49787 instead of going through
  // Vite's WS proxy. The proxy hop adds no value and reliably emits EPIPE /
  // ECONNRESET noise on every HMR reload. In prod, both server and UI are on
  // the same origin so this resolves to the same place.
  const isDev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const host = isDev ? `${location.hostname}:49787` : location.host;
  const url = `${proto}://${host}/ws`;

  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 500;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      backoff = 500;
    };
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (closed) return;
      const delay = backoff;
      backoff = Math.min(backoff * 2, 5000);
      setTimeout(connect, delay);
    };
    ws.onerror = () => {
      // onclose will follow and trigger reconnect.
    };
  };

  connect();

  return () => {
    closed = true;
    ws?.close();
  };
}
