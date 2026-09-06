/**
 * Ambient declarations for the test tree.
 *
 * `tsconfig.test.json` covers `tests/`, and the specs drive the mock through
 * globals TypeScript's DOM lib does not know about: Web Bluetooth is not in
 * `lib.dom.d.ts`, and `WebBleMock` is the IIFE bundle's global.
 *
 * WARNING: THIS FILE MUST STAY EXCEPTED IN .gitignore. The rule there aimed at
 * build output also matches hand-written declarations, and silently swallows
 * them. That is not hypothetical. This file was written once under TRA-1187,
 * went unstaged because of that rule, and `just validate` passed anyway because
 * it still existed on disk in the worktree. The worktree was removed at
 * cleanup, the file went with it, and `main` was left failing `typecheck:tests`
 * with 34 errors -- a gate that had been green against a file that could never
 * ship. The sibling exception for `src/global.d.ts` exists because the same trap
 * was hit before; that file has since been deleted, and this one replaced it
 * without inheriting its exception.
 */

interface Navigator {
  /** The mock, or real Chromium's. Deliberately `any`: the DOM lib has no Web Bluetooth types. */
  bluetooth: any;
}

interface Window {
  /** Set by the `./browser` IIFE bundle. */
  WebBleMock: any;
}

declare module '*/port-cleanup.js' {
  export const BRIDGE_MODULE: string;
  export const BRIDGE_SCRIPT: string;
  export function argvIsProtected(argv: string[]): boolean;
  export function listenerPidsOnPort(port: number): number[];
  export function isProtectedProcess(pid: number): boolean;
  export function killPort(port: number, log?: (message: string) => void): boolean;
}

declare module '*/bridge-staleness.js' {
  export const REPO_ROOT: string;
  export const DEFAULT_WS_PORT: number;
  export function resolveBridgePort(opts?: {
    env?: Record<string, string | undefined>;
    repoRoot?: string;
  }): number;
  export function processStartedAt(pid: number): number;
  export function checkoutOf(pid: number): string | null;
  export function lastBridgeCommitAt(checkout: string): number | null;
  export function newestSourceMtime(checkout: string): number | null;
  export function assertBridgeCurrent(opts?: {
    port?: number;
    log?: (message: string) => void;
    /** Injected only by tests, to exercise the branches a host WITHOUT /proc takes. */
    hostDeps?: HostProbeDeps;
  }): {
    checked: boolean;
    port: number;
    reason?: string;
    pid?: number;
    checkout?: string;
    started?: number;
    committed?: number;
    sourceAt?: number | null;
  };
}

declare module '*/bridge-service.js' {
  export const REPO_ROOT: string;
  export const UNIT: string;
  export const TEMPLATE: string;
  export function installedUnitPath(home?: string): string;
  export function renderUnit(template: string, repoRoot: string): string;
}

/**
 * What `scripts/host-capabilities.js` exports.
 *
 * TRA-1257. Declared here rather than in the module because the module is plain
 * JS on purpose: `scripts/pre-test-cleanup.js` runs it outside any TypeScript
 * toolchain, and both sides have to derive the answer from ONE declaration.
 */
interface HostProbeDeps {
  spawn?: (...args: any[]) => any;
  readFile?: (...args: any[]) => any;
}

interface HostCapability {
  because: string;
  probe: (deps: Required<HostProbeDeps>) => boolean;
}

declare module '*/host-capabilities.js' {
  export const FLOCK: string;
  export const PROCFS: string;
  export const CLK_TCK: string;
  export const LSOF: string;
  export const CAPABILITIES: Record<string, HostCapability>;
  export const CAPABILITY_IDS: string[];
  export function probeCapability(id: string, deps?: HostProbeDeps): boolean;
  export function hasCapability(id: string): boolean;
  export function missingCapabilities(
    ids: string[],
    deps?: HostProbeDeps
  ): Array<{ id: string; because: string }>;
  export function hostDescription(): string;
  export function renderNotRun(
    heading: string,
    entries: Array<{ what: string; because: string }>
  ): string;
}
