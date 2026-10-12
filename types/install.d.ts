// playwright-write-guard/install: the installer every entry point shares.

import type { APIRequestContext, BrowserContext } from 'playwright-core';
import type { Config, Policy } from './core.js';

/**
 * A request the guard judged: a write it blocked or observed (`block`, `observe`), a write a
 * caller's route fulfilled or aborted (`mocked`), or an allowed GET or HEAD that looks side
 * effecting (`suspect`). Also a WebSocket refused under `websockets: "block"` (`block`, no `method`).
 */
export interface RequestEvent {
  kind: 'request';
  action: 'block' | 'observe' | 'mocked' | 'suspect';
  reason: string;
  /** The effective method, upper case. Absent for a refused WebSocket. */
  method?: string;
  /** The effective URL, or the refused WebSocket's URL. */
  url: string;
  /**
   * Present only for a send through a request client: `"request-client"` for an
   * `APIRequestContext`, `"node-fetch"` for Node's `fetch`. Absent for a browser request.
   */
  via?: 'request-client' | 'node-fetch';
  /** The effective `content-type` header, when the request has one. */
  contentType?: string;
  /**
   * Present whenever `method` is: the effective request's header names, lower case, unique,
   * sorted with `Array.prototype.sort`. Never the values. `[]` when it has no headers.
   */
  headerNames?: string[];
  /** Only with `logBodies: true`: the first 500 characters of the effective body, when the request has one. */
  body?: string;
  /** ISO 8601 timestamp. */
  at: string;
}

/** A destructive control, or a suspect navigating link, the page blocked or observed. */
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
export interface WebSocketOpenEvent {
  kind: 'websocket';
  action: 'open';
  url: string;
  /** ISO 8601 timestamp. */
  at: string;
}

/**
 * An outbound WebSocket text frame matching `websocketWrites`: dropped (`block`, read-only)
 * or forwarded (`observe`, observe). Counts in `blocked` or `observed`.
 */
export interface WebSocketFrameEvent {
  kind: 'websocket';
  action: 'block' | 'observe';
  reason: string;
  /** The socket's URL. */
  url: string;
  /** Only with `logBodies: true`: the first 500 characters of the frame. */
  frame?: string;
  /** ISO 8601 timestamp. */
  at: string;
}

export type WebSocketEvent = WebSocketOpenEvent | WebSocketFrameEvent;

/** One event the guard recorded. */
export type GuardEvent = RequestEvent | ControlEvent | WebSocketEvent;

export interface GuardRecord {
  installed: true;
  policy: Policy;
  /** Requests the guard judged at browser egress, each counted once, at its first egress. No WebSockets, mocks or request-client sends. */
  routed_requests: number;
  /** Request, control and websocket events with `action: "block"`. */
  blocked: number;
  /** Request, control and websocket events with `action: "observe"`. */
  observed: number;
  /** Request events with `action: "mocked"`. */
  mocked: number;
  /** Request events with `action: "suspect"`. */
  suspect: number;
  events: GuardEvent[];
}

export interface GuardHandle {
  /** A snapshot of what the guard has seen so far. */
  record(): GuardRecord;
  /** Resolves after the last pending log append with the final record. The guard stays active until the context closes. */
  close(): Promise<GuardRecord>;
  /**
   * A proxy over `client` whose sends (`fetch`, `get`, `post`, `put`, `patch`, `delete`,
   * `head`) are judged with this guard's config and recorded here with
   * `via: "request-client"`; a blocked send rejects with
   * `write-guard: <METHOD> <URL> through APIRequestContext is refused under read-only`.
   * Relative URLs resolve against `baseURL` when given. Every other property reads through.
   */
  guardRequestClient<T extends APIRequestContext>(client: T, options?: { baseURL?: string }): T;
  /**
   * A function with `fetchFn`'s signature that judges each call with this guard's config,
   * records it here with `via: "node-fetch"`, and either rejects with
   * `write-guard: <METHOD> <URL> through fetch is refused under read-only` or returns
   * `fetchFn(input, init)` with the same arguments.
   */
  guardFetch<F extends (input: any, init?: any) => Promise<any>>(fetchFn: F): F;
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
