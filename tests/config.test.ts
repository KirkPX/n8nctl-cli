import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveConfig, setAccount, setBaseUrl } from "../src/config.js";
import { getCredentialStore, resetCredentialStore } from "../src/auth.js";
import { ConfigError } from "../src/errors.js";
import { assertWritable } from "../src/cli/guardrails.js";
import { configDir, settingsFilePath } from "../src/paths.js";
import { loadSettings, settingsSchema, updateSettings } from "../src/settings.js";

// n8n is self-hosted, so there is no default address.
const DEFAULT_BASE_URL = null;
const origEnv = { ...process.env };
let dir: string;
let file: string;

function seed(value: unknown): void {
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "n8nctl settings "));
  file = join(dir, "config.json");
  process.env = {
    ...origEnv,
    N8NCTL_CLI_CREDENTIAL_STORE: "memory",
    N8NCTL_CLI_CONFIG_FILE: file,
  };
  delete process.env.N8NCTL_READ_ONLY;
  delete process.env.N8NCTL_BASE_URL;
  delete process.env.N8NCTL_ACCOUNT;
  delete process.env.N8NCTL_API_KEY;
  resetCredentialStore(); // getCredentialStore caches
});

afterEach(() => {
  process.env = origEnv;
  rmSync(dir, { recursive: true, force: true });
  resetCredentialStore();
});

describe("resolveConfig precedence: flags > env > settings file/keychain > default", () => {
  it("falls back to the defaults when nothing is set", () => {
    expect(resolveConfig()).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      account: "default",
      apiKey: null,
      email: null,
      workflowsDir: "workflows",
      timeoutMs: undefined,
      delayMs: 0,
    });
  });

  it("reads baseUrl from the settings file when no env or flag is present", () => {
    seed({ baseUrl: "https://file.example.com" });
    expect(resolveConfig().baseUrl).toBe("https://file.example.com");
  });

  it("prefers env over the settings file", () => {
    seed({ baseUrl: "https://file.example.com" });
    process.env.N8NCTL_BASE_URL = "https://env.example.com";
    expect(resolveConfig().baseUrl).toBe("https://env.example.com");
  });

  it("prefers a flag over env and the settings file", () => {
    seed({ baseUrl: "https://file.example.com" });
    process.env.N8NCTL_BASE_URL = "https://env.example.com";
    expect(resolveConfig({ baseUrl: "https://flag.example.com" }).baseUrl).toBe("https://flag.example.com");
  });

  it("reads apiKey from the keychain for the account in the settings file", () => {
    seed({ account: "work" });
    getCredentialStore().setApiKey("work", "key-from-keychain");
    expect(resolveConfig().apiKey).toBe("key-from-keychain");
  });

  it("prefers env over the keychain", () => {
    getCredentialStore().setApiKey("default", "key-from-keychain");
    process.env.N8NCTL_API_KEY = "key-from-env";
    expect(resolveConfig().apiKey).toBe("key-from-env");
  });

  it("ignores empty env vars", () => {
    process.env.N8NCTL_BASE_URL = "";
    process.env.N8NCTL_API_KEY = "";
    expect(resolveConfig()).toMatchObject({ baseUrl: DEFAULT_BASE_URL, apiKey: null });
  });

  it("reads delayMs from the settings file, and N8NCTL_DELAY_MS beats it", () => {
    seed({ delayMs: 1000 });
    expect(resolveConfig().delayMs).toBe(1000);
    process.env.N8NCTL_DELAY_MS = "250";
    expect(resolveConfig().delayMs).toBe(250);
    delete process.env.N8NCTL_DELAY_MS;
  });

  it("passes timeoutMs through to the client options", () => {
    seed({ timeoutMs: 5000 });
    expect(resolveConfig().timeoutMs).toBe(5000);
  });
});

describe("writes are validated", () => {
  it("stores a valid account, trimmed", () => {
    setAccount("  work  ");
    expect(loadSettings().account).toBe("work");
  });

  it("refuses an empty account instead of storing garbage", () => {
    expect(() => setAccount("   ")).toThrow(ConfigError);
    expect(loadSettings().account).toBeUndefined();
  });

  it("refuses a base URL that is not a URL", () => {
    expect(() => setBaseUrl("not a url")).toThrow(ConfigError);
  });

  it("names the settings file in the hint", () => {
    try {
      setAccount("");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ConfigError).hint).toContain("config.json");
    }
  });
});

describe("settings file", () => {
  it("keeps other settings when one changes", () => {
    seed({ readOnly: true, timeoutMs: 7 });
    setAccount("work");
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      readOnly: true,
      timeoutMs: 7,
      account: "work",
    });
  });

  it("removes a key when the patch value is undefined", () => {
    seed({ account: "work", timeoutMs: 7 });
    updateSettings({ account: undefined });
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ timeoutMs: 7 });
  });

  it("treats a missing file as no settings", () => {
    expect(loadSettings()).toEqual({});
  });

  it("names the file when the JSON is broken, and leaves it alone", () => {
    seed("{not json");
    expect(() => loadSettings()).toThrow(/not valid JSON/);
    expect(() => updateSettings({ readOnly: true })).toThrow(ConfigError);
    expect(readFileSync(file, "utf-8")).toBe("{not json");
  });

  it("refuses a misspelt key, because ignoring readonly would allow writes", () => {
    seed({ readonly: true });
    expect(() => loadSettings()).toThrow(/Invalid settings/);
    expect(() => assertWritable({})).toThrow(ConfigError);
  });

  it("leaves no temporary file behind", async () => {
    setAccount("work");
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });

  it("accepts the shipped example file", () => {
    const example = resolve(import.meta.dirname ?? ".", "../examples/config.json");
    const parsed = settingsSchema.safeParse(JSON.parse(readFileSync(example, "utf-8")));
    expect(parsed.success).toBe(true);
  });
});

describe("read-only precedence: flag > env > settings file", () => {
  it("is off by default", () => {
    expect(() => assertWritable({})).not.toThrow();
  });

  it("reads the settings file", () => {
    seed({ readOnly: true });
    expect(() => assertWritable({})).toThrow(/Read-only/);
  });

  it("lets the environment turn it off for one run", () => {
    seed({ readOnly: true });
    process.env.N8NCTL_READ_ONLY = "0";
    expect(() => assertWritable({})).not.toThrow();
  });

  it("lets the environment turn it on over the settings file", () => {
    seed({ readOnly: false });
    process.env.N8NCTL_READ_ONLY = "1";
    expect(() => assertWritable({})).toThrow(/Read-only/);
  });

  it("lets the flag win over an environment that turned it off", () => {
    process.env.N8NCTL_READ_ONLY = "0";
    expect(() => assertWritable({ readOnly: true })).toThrow(/Read-only/);
  });
});

describe("paths", () => {
  it("uses APPDATA on Windows", () => {
    expect(configDir({ APPDATA: "appdata" }, "win32", "home")).toBe(join("appdata", "n8nctl-cli"));
  });

  it("falls back to the roaming folder on Windows without APPDATA", () => {
    expect(configDir({}, "win32", "home")).toBe(join("home", "AppData", "Roaming", "n8nctl-cli"));
  });

  it("uses XDG_CONFIG_HOME when set, and ~/.config otherwise", () => {
    expect(configDir({ XDG_CONFIG_HOME: "xdg" }, "darwin", "home")).toBe(join("xdg", "n8nctl-cli"));
    expect(configDir({}, "linux", "home")).toBe(join("home", ".config", "n8nctl-cli"));
  });

  it("lets the environment variable name the settings file", () => {
    expect(settingsFilePath()).toBe(file);
  });
});
