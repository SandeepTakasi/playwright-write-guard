// playwright-write-guard/install: the installer every entry point shares.

import type { BrowserContext } from 'playwright-core';
import type { Config, Policy } from './core.js';

/** One write the guard blocked or observed. Request events carry `method` and `url`; control events carry `label`. */
export interface GuardEvent {
  kind: 'request' | 'control';
  action: 'block' | 'observe';
  reason: string;
  method?: string;
  url?: string;
  label?: string;
  /** ISO 8601 timestamp. */
  at: string;
}

export interface GuardRecord {
  installed: true;
  policy: Policy;
  /** Requests the guard judged, each counted once. */
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
