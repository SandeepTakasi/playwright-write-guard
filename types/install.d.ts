// playwright-write-guard/install: the installer every entry point shares.

import type { BrowserContext } from 'playwright-core';
import type { Config, Policy } from './core.js';

/** A write the guard blocked or observed at egress, or a WebSocket refused under `websockets: "block"`. */
export interface RequestEvent {
  kind: 'request';
  action: 'block' | 'observe';
  reason: string;
  /** The effective method, upper case. Absent for a refused WebSocket. */
  method?: string;
  /** The effective URL, or the refused WebSocket's URL. */
  url: string;
  /** The effective `content-type` header, when the request has one. */
  contentType?: string;
  /** Only with `logBodies: true`: the first 500 characters of the effective body, when the request has one. */
  body?: string;
  /** ISO 8601 timestamp. */
  at: string;
}

/** A destructive control the page blocked or observed. */
export interface ControlEvent {
  kind: 'control';
  action: 'block' | 'observe';
  reason: string;
  /** Trimmed, at most 120 characters. */
  label: string;
  /** ISO 8601 timestamp. */
  at: string;
}

/** A WebSocket opened under `websockets: "allow"`. Counts in neither `blocked` nor `observed`. */
export interface WebSocketEvent {
  kind: 'websocket';
  action: 'open';
  url: string;
  /** ISO 8601 timestamp. */
  at: string;
}

/** One event the guard recorded. */
export type GuardEvent = RequestEvent | ControlEvent | WebSocketEvent;

export interface GuardRecord {
  installed: true;
  policy: Policy;
  /** Requests the guard judged at egress, each counted once, at its first egress. WebSockets are not counted. */
  routed_requests: number;
  /** Request and control events with `action: "block"`. */
  blocked: number;
  /** Request and control events with `action: "observe"`. */
  observed: number;
  events: GuardEvent[];
}

export interface GuardHandle {
  /** A snapshot of what the guard has seen so far. */
  record(): GuardRecord;
  /** Resolves after the last pending log append with the final record. The guard stays active until the context closes. */
  close(): Promise<GuardRecord>;
}

/**
 * Guard a browser context. Compiles `config` (default `{}`); a second call on the same
 * context returns the first call's handle. Throws `write-guard: this context is already
 * guarded by another process; use one mode, not both` when another process has guarded it.
 */
export function install(context: BrowserContext, config?: Config): Promise<GuardHandle>;

/**
 * Read a config: `path`, else `WRITE_GUARD_CONFIG`, else `write-guard.config.json` when it
 * exists, else `{}`. `WRITE_GUARD_POLICY`, when set, overrides `policy`. Validated through
 * `compileConfig`; returns the raw config.
 */
export function loadConfig(path?: string): Config;
