import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { redact, ApiError, ConfigError, LoginError, UsageError } from "../src/errors.js";

const SRC = path.resolve(import.meta.dirname ?? ".", "../src");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

describe("redact", () => {
  it("redacts long strings showing first/last chars", () => {
    expect(redact("abcdefghijklmnopqrstuvwxyz")).toBe("abcd****wxyz");
  });

  it("returns **** for very short strings", () => {
    expect(redact("ab")).toBe("****");
  });

  it("returns **** when show is larger than the value", () => {
    expect(redact("abcdef", 8)).toBe("****");
  });
});

describe("ApiError", () => {
  it("formats message with status, operation, and safe detail", () => {
    const err = new ApiError({
      status: 404,
      statusText: "Not Found",
      operation: "GET /items",
      safeDetail: "not found",
    });
    expect(err.message).toBe("GET /items failed: 404 Not Found — not found");
    expect(err.name).toBe("ApiError");
    expect(err.status).toBe(404);
  });
});

describe("ConfigError", () => {
  it("stores hint", () => {
    const err = new ConfigError("missing config", "run login");
    expect(err.hint).toBe("run login");
  });
});

describe("typed error classes", () => {
  it("UsageError and LoginError still match ConfigError", () => {
    expect(new UsageError("bad flag")).toBeInstanceOf(ConfigError);
    expect(new LoginError("no token")).toBeInstanceOf(ConfigError);
    expect(new UsageError("bad flag").name).toBe("UsageError");
    expect(new LoginError("no token").name).toBe("LoginError");
  });

  it("carries a hint the top-level handler can print", () => {
    expect(new LoginError("Not signed in.", "Run login.").hint).toBe("Run login.");
  });
});

describe("every throw is typed", () => {
  // All thrown errors come from errors.ts, so the top-level handler can format
  // them uniformly.
  it("no raw `throw new Error(` in src/", () => {
    const offenders = filesUnder(SRC)
      .filter((f) => f.endsWith(".ts"))
      // page.ts contains a browser-side script as a string, not Node code.
      .filter((f) => !f.endsWith(path.join("login", "page.ts")))
      .filter((f) => /throw new Error\s*\(/.test(readFileSync(f, "utf-8")))
      .map((f) => path.relative(SRC, f));

    expect(offenders).toEqual([]);
  });

  it("the top-level handler sets exitCode instead of calling process.exit", () => {
    const source = readFileSync(path.join(SRC, "index.ts"), "utf-8");
    const handler = source.slice(source.indexOf("program.parseAsync"));
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).not.toContain("process.exit(");
  });
});
