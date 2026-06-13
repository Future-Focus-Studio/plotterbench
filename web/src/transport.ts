// Transport abstraction (backlog task 15).
//
// The React UI talks to the backend through a Transport, never directly through
// fetch/WebSocket. The source-available web build fulfills the contract over
// HTTP + WebSocket (createHttpTransport, below). The paid Electron build will
// fulfill the SAME contract over IPC — feature-identical, just a different wire
// (see docs/STRATEGY.md). When the Electron scaffold lands (task 14), add a
// createIpcTransport() and return it from selectTransport().

import type { OptimizeStats, PlotOptions, PortInfo, WsEvent } from "@shared/types.js";

/**
 * The request/response surface the UI uses, independent of how it reaches the
 * backend. This is the contract any transport (HTTP, IPC, …) must satisfy, so it
 * doubles as the spec for the Electron IPC channel.
 */
export interface PlotterApi {
  ports(): Promise<{ ports: PortInfo[]; connected: boolean }>;
  connect(path: string): Promise<{ connected: boolean; version: string; driverId?: string; driverName?: string }>;
  disconnect(): Promise<{ connected: false }>;
  pen(state: "up" | "down"): Promise<{ ok: true }>;
  motors(enable: boolean): Promise<{ ok: true }>;
  home(): Promise<{ ok: true }>;
  setOrigin(): Promise<{ ok: true }>;
  plot(svg: string, options: PlotOptions): Promise<{ started: true; polylineCount: number }>;
  cancel(): Promise<{ ok: true }>;
  pause(): Promise<{ ok: true }>;
  resume(): Promise<{ ok: true }>;
  optimize(svg: string): Promise<{ stats: OptimizeStats }>;
  plan(svg: string, options: PlotOptions): Promise<{ polylines: { x: number; y: number }[][] }>;
}

/** Subscribe to server-pushed events; returns an unsubscribe function. */
export type EventSubscribe = (onMessage: (e: WsEvent) => void) => () => void;

export interface Transport {
  api: PlotterApi;
  subscribe: EventSubscribe;
}

// --- HTTP + WebSocket transport (web / source-available build) -------------

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

function wsUrl(): string {
  // In dev, talk directly to the API server on :49787 instead of going through
  // Vite's WS proxy. The proxy hop adds no value and reliably emits EPIPE /
  // ECONNRESET noise on every HMR reload. In prod, both server and UI are on
  // the same origin so this resolves to the same place.
  const isDev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const host = isDev ? `${location.hostname}:49787` : location.host;
  return `${proto}://${host}/ws`;
}

export function createHttpTransport(): Transport {
  const api: PlotterApi = {
    ports: () => req("/api/ports"),
    connect: (path) => req("/api/connect", { method: "POST", body: JSON.stringify({ path }) }),
    disconnect: () => req("/api/disconnect", { method: "POST" }),
    pen: (state) => req("/api/pen", { method: "POST", body: JSON.stringify({ state }) }),
    motors: (enable) => req("/api/motors", { method: "POST", body: JSON.stringify({ enable }) }),
    home: () => req("/api/home", { method: "POST" }),
    setOrigin: () => req("/api/set-origin", { method: "POST" }),
    plot: (svg, options) => req("/api/plot", { method: "POST", body: JSON.stringify({ svg, options }) }),
    cancel: () => req("/api/cancel", { method: "POST" }),
    pause: () => req("/api/pause", { method: "POST" }),
    resume: () => req("/api/resume", { method: "POST" }),
    optimize: (svg) => req("/api/optimize", { method: "POST", body: JSON.stringify({ svg }) }),
    plan: (svg, options) => req("/api/plan", { method: "POST", body: JSON.stringify({ svg, options }) }),
  };

  const subscribe: EventSubscribe = (onMessage) => {
    const url = wsUrl();
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
  };

  return { api, subscribe };
}

// --- Transport selection ---------------------------------------------------

/**
 * Pick the transport for the current runtime. Today there is only the HTTP/WS
 * transport. When the Electron build lands (task 14), detect the preload bridge
 * here (e.g. `window.plotterbenchIpc`) and return createIpcTransport() instead.
 */
export function selectTransport(): Transport {
  return createHttpTransport();
}
