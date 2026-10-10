// playwright-write-guard: the decision core. Pure functions, no I/O, no Playwright types.

/** `read-only` blocks writes; `observe` records them and lets them through. */
export type Policy = 'read-only' | 'observe';

/**
 * A request method a signature can name: `"*"` (any method) or a method name matching
 * `^[A-Za-z][A-Za-z0-9-]*$` (for example `POST`, `REPORT` or `M-SEARCH`), compiled to upper
 * case and compared with the request's method in upper case.
 */
export type SigMethod = string;

/**
 * A request signature. `url` and `body` are regex sources, compiled with no flags
 * (case-sensitive) and tested unanchored against the full URL and the request body.
 * A signature with `body` never matches a request that has no body. A signature with
 * `headers` matches only when every named header is present and its value matches.
 */
export interface Sig {
  method: SigMethod;
  url: string;
  /** Absent or `null`: the signature names no body. */
  body?: string | null;
  /**
   * Header name to a regex source. Names compare case-insensitively; values are compiled
   * with no flags and tested unanchored. Absent or `null`: the signature names no headers.
   */
  headers?: Record<string, string> | null;
}

/** The raw config. Every key is optional; unknown keys are ignored. */
export interface Config {
  /** Default `"read-only"`. */
  policy?: Policy;
  /** Requests matching any of these are never writes. */
  allow?: Sig[];
  /** Requests matching any of these are writes even when their method is GET, HEAD or OPTIONS. */
  writes?: Sig[];
  controls?: {
    /** Regex sources, compiled case-insensitive, added to the built-in verbs. */
    text?: string[];
    /** Class name prefixes; a control with a class starting with one is destructive. */
    icons?: string[];
  };
  /**
   * Default `true`: include the 11 built-in verbs in the text pattern: `save`, `delete`,
   * `remove`, `publish`, `send`, `archive`, `pay`, `purchase`, `log out`, `sign out`, `logout`.
   */
  defaultControls?: boolean;
  /** Default `"allow"`. */
  websockets?: 'allow' | 'block';
  /** JSONL audit log path, relative to the working directory. Default `"write-guard.jsonl"`; `null` turns it off. */
  log?: string | null;
  /** Default `false`: when `true`, request events carry `body`, the first 500 characters of the request body. */
  logBodies?: boolean;
}

export interface CompiledSig {
  /** `"*"` or the method name in upper case. */
  method: SigMethod;
  url: RegExp;
  /** `null` when the signature names no body. */
  body: RegExp | null;
  /** Header names in lower case; empty when the signature names no headers. */
  headers: Array<{ name: string; value: RegExp }>;
}

/** What `compileConfig` returns: every default applied, every pattern compiled. */
export interface CompiledConfig {
  policy: Policy;
  allow: CompiledSig[];
  writes: CompiledSig[];
  /** The built-in verbs (unless `defaultControls` is false) and `controls.text`, as one case-insensitive pattern; `null` when there are none. */
  text: RegExp | null;
  /** `controls.icons`; there are no built-in icons. */
  icons: string[];
  websockets: 'allow' | 'block';
  log: string | null;
  logBodies: boolean;
}

export interface RequestInput {
  method: string;
  url: string;
  /** The request body; `null` or absent when it has none. */
  body?: string | null;
  /** The request headers, names in any case (`decideRequest` lower-cases them); absent when it has none. */
  headers?: Record<string, string>;
}

export interface RequestDecision {
  action: 'allow' | 'block' | 'observe';
  reason: string;
}

export interface ControlInput {
  /** The control's label. */
  label: string;
  /** Every class name on the control and its descendants. */
  icons: string[];
}

export interface ControlDecision {
  action: 'allow' | 'block' | 'observe';
  reason: string;
}

/**
 * Validate a raw config and apply its defaults. `null` and `undefined` mean `{}`.
 * Throws `write-guard: <path>: <message>` on anything malformed.
 */
export function compileConfig(raw?: Config | null): CompiledConfig;

/** `block` (read-only) or `observe` (observe) for a write, else `allow`. */
export function decideRequest(request: RequestInput, config: CompiledConfig): RequestDecision;

/** `block` (read-only) or `observe` (observe) for a destructive control, else `allow`. */
export function decideControl(control: ControlInput, config: CompiledConfig): ControlDecision;
