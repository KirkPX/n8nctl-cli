import { describe, expect, it, vi } from "vitest";
import {
  abortOutcome,
  confirmDestructive,
  dryRunSummary,
  printDryRun,
  requireApiKey,
} from "../src/cli/guardrails.js";
import { reporterFor } from "../src/cli/output.js";

describe("dryRunSummary", () => {
  it("returns changed=true when wouldChange is true", () => {
    const result = dryRunSummary(true, "would delete 3 items");
    expect(result.changed).toBe(true);
    expect(result.summary).toBe("would delete 3 items");
  });

  it("returns changed=false when wouldChange is false", () => {
    const result = dryRunSummary(false, "nothing to do");
    expect(result.changed).toBe(false);
  });
});

describe("printDryRun", () => {
  it("prints with DRY RUN prefix when dryRun is true", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printDryRun({ changed: true, summary: "would delete" }, true, reporterFor("pretty"));
    expect(spy).toHaveBeenCalledOnce();
    const output = spy.mock.calls[0]![0] as string;
    expect(output).toContain("DRY RUN");
    expect(output).toContain("would delete");
    spy.mockRestore();
  });

  it("emits one parseable outcome in json mode, not prose", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printDryRun({ changed: true, summary: "would delete 3" }, true, reporterFor("json"));
    expect(spy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(spy.mock.calls[0]![0] as string);
    // The three outcomes have to survive as data, not as a coloured string.
    expect(parsed).toMatchObject({ dryRun: true, changed: false, summary: "would delete 3" });
    spy.mockRestore();
  });
});

describe("confirmDestructive", () => {
  // Without a TTY on stdin, readline's callback never fires: the event loop
  // would drain and the process would exit 0 having changed nothing.
  it("refuses instead of prompting when stdin is not a TTY", async () => {
    const original = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      expect(await confirmDestructive("Delete?", {})).toEqual({
        confirmed: false,
        reason: "needs-yes",
      });
    } finally {
      process.stdin.isTTY = original;
    }
  });

  it("confirms on --yes without touching stdin", async () => {
    expect(await confirmDestructive("Delete?", { yes: true })).toEqual({ confirmed: true });
  });

  it("refuses in json mode", async () => {
    expect(await confirmDestructive("Delete?", { json: true })).toEqual({
      confirmed: false,
      reason: "needs-yes",
    });
  });
});

describe("abortOutcome", () => {
  it("distinguishes a declining human from a refused machine", () => {
    // A human saying no is a successful no-op. A machine that forgot --yes is
    // an error the caller has to act on.
    expect(abortOutcome("declined", "Aborted.").ok).toBe(true);
    expect(abortOutcome("needs-yes", "Aborted.").ok).toBe(false);
    expect(abortOutcome("needs-yes", "Aborted.").hint).toContain("--yes");
  });
});

describe("requireApiKey", () => {
  it("throws when apiKey is null", () => {
    expect(() => requireApiKey(null)).toThrow("Not signed in");
  });

  it("throws when apiKey is undefined", () => {
    expect(() => requireApiKey(undefined)).toThrow("Not signed in");
  });

  it("does not throw for valid apiKey", () => {
    expect(() => requireApiKey("key-123")).not.toThrow();
  });
});
