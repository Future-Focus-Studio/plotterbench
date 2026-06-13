// Public client API surface. This module is intentionally thin: it selects a
// transport (HTTP/WS today, IPC in the Electron build — see transport.ts and
// docs/STRATEGY.md) and re-exports the pieces the UI imports. Existing imports
// (App.tsx, etc.) keep importing `api`, `openWs`, and the shared types from
// "./api.js" unchanged.
import type { OptimizeStats, PlotOptions, PortInfo, WsEvent } from "@shared/types.js";
import { selectTransport } from "./transport.js";
export type { OptimizeStats, PlotOptions, PortInfo, WsEvent };
export type { PlotterApi, Transport } from "./transport.js";

const transport = selectTransport();

export const api = transport.api;

export function openWs(onMessage: (e: WsEvent) => void): () => void {
  return transport.subscribe(onMessage);
}
