// Mutation guardrails. Every command that changes remote data routes through here so the safety
// behavior is identical everywhere:
//   - destructive commands require confirmation unless --yes
//   - in --json / non-interactive mode we NEVER prompt; an unconfirmed mutation is refused
//   - read-only mode (flag, env or settings file) blocks all mutations, for agents/automation
//   - final output distinguishes: changed / would-change (dry-run) / nothing-changed

import pc from "picocolors";
import { createInterface } from "node:readline";
import { ask } from "./ask.js";
import { ConfigError } from "../errors.js";
import { loadSettings } from "../settings.js";
import type { Reporter } from "./output.js";

export type GuardOptions = {
  yes?: boolean;
  json?: boolean;
  dryRun?: boolean;
  readOnly?: boolean;
};

export type DryRunResult = { changed: boolean; summary: string };

export function dryRunSummary(wouldChange: boolean, summary: string): DryRunResult {
  return { changed: wouldChange, summary };
}

/**
 * The one shape every mutating command emits, in either format.
 *
 * A consumer reads the three required outcomes as:
 *   dryRun                      -> would change
 *   !dryRun && changed          -> changed
 *   !dryRun && !changed         -> nothing changed (including aborts)
 */
export type MutationOutcome<T = unknown> = {
  ok: boolean;
  dryRun: boolean;
  changed: boolean;
  aborted?: boolean;
  summary: string;
  hint?: string;
  counts?: { total: number; succeeded: number; failed: number };
  results?: T[];
};

/**
 * Emit the dry-run / changed / nothing-changed outcome.
 *
 * The Reporter parameter is REQUIRED, not optional-with-a-default. An optional
 * one reproduces exactly the bug this exists to prevent: forget it, get prose
 * in a pipe. Required means `npm run typecheck` lists every unconverted call
 * site for you.
 */
export function printDryRun(
  result: DryRunResult,
  isDryRun: boolean,
  r: Reporter,
  extra: Partial<MutationOutcome> & Record<string, unknown> = {}
): void {
  const outcome: MutationOutcome = {
    ok: true,
    dryRun: isDryRun,
    changed: isDryRun ? false : result.changed,
    summary: result.summary,
    ...extra,
  };

  if (isDryRun) {
    r.result(outcome, `${pc.yellow("[DRY RUN]")} ${result.summary} (nothing was changed)`);
  } else if (result.changed) {
    r.result(outcome, pc.green(result.summary));
  } else {
    r.result(outcome, pc.dim(`${result.summary} (nothing changed)`));
  }
}

/** The outcome for a refused or declined confirmation. */
export function abortOutcome(
  reason: AbortReason,
  summary: string
): MutationOutcome {
  return {
    ok: reason === "declined",
    dryRun: false,
    changed: false,
    aborted: true,
    summary,
    ...(reason === "needs-yes"
      ? { hint: "Pass --yes to confirm non-interactively." }
      : {}),
  };
}

/**
 * Refuse anything that would change remote data when read-only is in force.
 *
 * Read-only is the safe choice for agents and automation: it lets someone run a
 * CLI they do not fully trust without risking a write. Every mutating command
 * must call this before doing anything.
 *
 * --read-only always wins. Below it, an explicit environment value beats the
 * settings file in either direction, so one run can opt out of a read-only
 * default with N8NCTL_READ_ONLY=0.
 */
export function assertWritable(opts: GuardOptions = {}): void {
  const fromEnv = process.env.N8NCTL_READ_ONLY;
  if (opts.readOnly || (fromEnv ? isTruthy(fromEnv) : loadSettings().readOnly === true)) {
    throw new ConfigError(
      "Read-only mode is on, so this command refused to change anything.",
      "Check --read-only, N8NCTL_READ_ONLY, and readOnly in the settings file (`n8nctl config show`)."
    );
  }
}

function isTruthy(value: string): boolean {
  return !["0", "false", "no", ""].includes(value.toLowerCase());
}

export type AbortReason = "declined" | "needs-yes";

export type ConfirmResult =
  | { confirmed: true }
  | { confirmed: false; reason: AbortReason };

/**
 * Confirm a destructive action.
 * - --yes  -> confirmed (explicit consent)
 * - --json or non-interactive stdin -> refused as "needs-yes" (never prompt a
 *   machine, and never wait on a prompt nothing can answer)
 * - otherwise -> interactive y/N on stderr (so stdout stays clean for piping).
 *   Ctrl-C rejects with InterruptedError, and Ctrl-D counts as no.
 *
 * The reason is returned, not collapsed into a bare false: "a human typed n"
 * and "a machine was refused for not passing --yes" are different events with
 * different next steps, and only the second should exit non-zero.
 *
 * Keyed on stdin, not stdout: whether a human can answer is about the input
 * side, so `cli delete … | jq` from a terminal still prompts.
 */
export async function confirmDestructive(
  message: string,
  opts: GuardOptions = {}
): Promise<ConfirmResult> {
  if (opts.yes) return { confirmed: true };
  if (opts.json || !process.stdin.isTTY) {
    return { confirmed: false, reason: "needs-yes" };
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await ask(rl, `${message} (y/N) `);
    return answer.trim().toLowerCase() === "y"
      ? { confirmed: true }
      : { confirmed: false, reason: "declined" };
  } finally {
    rl.close();
  }
}

export function requireApiKey(apiKey: string | null | undefined): asserts apiKey is string {
  if (!apiKey || apiKey.length === 0) {
    throw new ConfigError("Not signed in.", "Run `n8nctl login`, or set N8NCTL_API_KEY.");
  }
}
