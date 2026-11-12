import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { configPath, configShow } from "../src/cli/commands/config.js";
import { doctorCommand } from "../src/cli/commands/doctor.js";
import { reporterFor } from "../src/cli/output.js";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const SRC = path.join(ROOT, "src");
const distIndex = path.join(ROOT, "dist", "index.js");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

// The Output Contract is only worth anything if it cannot be bypassed. Every
// legitimate kind of writing has a Reporter method, so a console.log inside a
// command is always the contract being broken — usually prose that corrupts a
// pipe, because resolveFormat() returns "json" for ANY non-TTY stdout, not just
// for --json.
//
// This is a source guard rather than a behavioural test on purpose: it fails on
// a NEW command written the old way, which is how the violation spreads.
describe("output contract", () => {
  it("no command writes to stdout directly", () => {
    const offenders = filesUnder(path.join(SRC, "cli", "commands"))
      .filter((f) => f.endsWith(".ts"))
      .filter((f) =>
        /(^|[^.\w])console\.log\s*\(|process\.stdout\.write/.test(readFileSync(f, "utf-8"))
      )
      .map((f) => path.relative(SRC, f));

    expect(offenders).toEqual([]);
  });

  it("guardrails never writes to stdout directly either", () => {
    const source = readFileSync(path.join(SRC, "cli", "guardrails.ts"), "utf-8");
    expect(/(^|[^.\w])console\.log\s*\(/.test(source)).toBe(false);
  });
});

describe("piped output is machine-readable", () => {
  // execFile gives a non-TTY stdout. No --json flag anywhere in here on purpose.
  it("doctor emits one parseable JSON document when piped", async () => {
    const { stdout } = await exec(process.execPath, [distIndex, "doctor"]);
    expect(JSON.parse(stdout)).toHaveProperty("checks");
  });

  it("auth status emits one parseable JSON document when piped", async () => {
    const { stdout } = await exec(process.execPath, [distIndex, "auth"]);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it("a failed command leaves stdout empty and puts one JSON envelope on stderr", async () => {
    // list refuses before any request, because no key is set.
    const failed = await exec(process.execPath, [distIndex, "list"]).catch(
      (e: { code: number; stdout: string; stderr: string }) => e
    );

    expect((failed as { code: number }).code).toBe(1);
    expect((failed as { stdout: string }).stdout).toBe("");
    expect(JSON.parse((failed as { stderr: string }).stderr)).toMatchObject({ error: true });
  });

  it.each([
    ["doctor", () => doctorCommand({ json: true })],
    ["config path", () => configPath({ json: true })],
    ["config show", () => configShow({ json: true })],
  ])("%s writes to stdout exactly once in json mode", async (_name, command) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await command();
      expect(log).toHaveBeenCalledOnce();
      expect(() => JSON.parse(log.mock.calls[0]![0] as string)).not.toThrow();
    } finally {
      log.mockRestore();
    }
  });
});

describe("Reporter", () => {
  function capture(run: (r: ReturnType<typeof reporterFor>) => void, format: "json" | "pretty") {
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...a: unknown[]) => out.push(a.join(" "));
    console.error = (...a: unknown[]) => err.push(a.join(" "));
    try {
      run(reporterFor(format));
    } finally {
      console.log = log;
      console.error = error;
    }
    return { out, err };
  }

  it("emits parseable JSON and nothing else in json mode", () => {
    const { out, err } = capture((r) => {
      r.note("connecting...");
      r.line("a human-only line");
      r.result({ ok: true, id: 7 }, "Done!");
    }, "json");

    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({ ok: true, id: 7 });
    // note() and line() must not reach stdout, and note() is pretty-only.
    expect(err).toEqual([]);
  });

  it("prefers the human rendering in pretty mode", () => {
    const { out, err } = capture((r) => {
      r.note("connecting...");
      r.result({ ok: true }, "Done!");
    }, "pretty");

    expect(out).toEqual(["Done!"]);
    expect(err).toEqual(["connecting..."]);
  });

  it("warns on stderr in both formats", () => {
    expect(capture((r) => r.warn("careful"), "json").err).toEqual(["careful"]);
    expect(capture((r) => r.warn("careful"), "pretty").err).toEqual(["careful"]);
  });
});
