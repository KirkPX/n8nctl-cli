import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError } from "../src/errors.js";
import { loadSettings, setSetting, unsetSetting } from "../src/settings.js";

const saved = process.env.N8NCTL_CLI_CONFIG_FILE;
let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "n8nctl réglages "));
  file = join(root, "config.json");
  process.env.N8NCTL_CLI_CONFIG_FILE = file;
});

afterEach(() => {
  process.env.N8NCTL_CLI_CONFIG_FILE = saved;
  rmSync(root, { recursive: true, force: true });
});

describe("config set and unset", () => {
  it("converts each value to the setting's type", () => {
    setSetting("readOnly", "true");
    setSetting("timeoutMs", "60000");
    setSetting("account", "work");
    expect(loadSettings()).toEqual({ readOnly: true, timeoutMs: 60000, account: "work" });
  });

  it("refuses an unknown name or a value of the wrong type", () => {
    expect(() => setSetting("readonly", "true")).toThrow(UsageError);
    expect(() => setSetting("readOnly", "yes")).toThrow(/true or false/);
    expect(() => setSetting("timeoutMs", "1.5")).toThrow(/whole number/);
  });

  it("checks the whole file before it writes", () => {
    setSetting("readOnly", "true");
    const before = readFileSync(file, "utf-8");
    expect(() => setSetting("baseUrl", "not a url")).toThrow(/baseUrl/);
    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  it("removes a value, and says when it was not set", () => {
    setSetting("readOnly", "true");
    expect(unsetSetting("readOnly")).toBe(true);
    expect(unsetSetting("readOnly")).toBe(false);
    expect(loadSettings()).toEqual({});
  });

  it("refuses names that reach JavaScript's own objects", () => {
    expect(() => setSetting("__proto__.polluted", "x")).toThrow(UsageError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
