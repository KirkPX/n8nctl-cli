// Unit smoke tests for rules that cut across commands. Extend with per-command tests.
// The built CLI is tested in built-binary.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { redact, safeErrorMessage } from "../src/errors.js";
import { resolveFormat } from "../src/cli/output.js";
import { resolveConfig } from "../src/config.js";

describe("redact", () => {
  it("masks the middle of a secret", () => {
    expect(redact("supersecrettoken12345")).toBe("supe****2345");
  });
  it("fully masks short secrets", () => {
    expect(redact("short")).toBe("****");
  });
});

describe("safeErrorMessage", () => {
  it("strips URL credentials", () => {
    expect(safeErrorMessage("failed https://user:pass@api.example.com/x")).toBe(
      "failed https://****@api.example.com/x"
    );
  });
});

describe("resolveFormat", () => {
  it("returns json when --json is passed", () => {
    expect(resolveFormat({ json: true })).toBe("json");
  });
});

describe("config precedence", () => {
  beforeEach(() => {
    process.env.N8NCTL_API_KEY = "";
    process.env.N8NCTL_BASE_URL = "";
  });

  it("prefers a flag over an env var", () => {
    process.env.N8NCTL_BASE_URL = "https://env.example.com";
    expect(resolveConfig({ baseUrl: "https://flag.example.com" }).baseUrl).toBe(
      "https://flag.example.com"
    );
  });

  it("uses the env var when no flag is given", () => {
    process.env.N8NCTL_API_KEY = "env-key";
    expect(resolveConfig().apiKey).toBe("env-key");
  });
});
