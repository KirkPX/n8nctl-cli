import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FileCredentialStore,
  getCredentialStore,
  KeyringWithFileFallback,
  resetCredentialStore,
  type KeyStore,
} from "../src/auth.js";
import { updateSettings } from "../src/settings.js";

const origEnv = { ...process.env };
let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "n8nctl-cred-"));
  file = join(root, "sub", "credentials.json");
  process.env.N8NCTL_CLI_CREDENTIAL_STORE = "file";
  process.env.N8NCTL_CLI_CREDENTIALS_FILE = file;
  resetCredentialStore();
});

afterEach(() => {
  // Restore, not delete: with no store named, the next test would open the real keychain.
  process.env = { ...origEnv };
  rmSync(root, { recursive: true, force: true });
  resetCredentialStore();
});

// The file store lets SSH sessions sign in, because macOS closes the keychain to them.
describe("file credential store", () => {
  it("saves, reads back and keeps the file private", () => {
    const store = getCredentialStore();
    expect(store.kind).toBe("file");
    expect(store.getApiKey("acct")).toBeNull();
    expect(store.setApiKey("acct", "k1")).toBe("file");
    expect(store.getApiKey("acct")).toBe("k1");
    // Windows has no POSIX mode bits. There the profile folder's permissions apply.
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  it("tightens this CLI's own folder when saving settings created it first", () => {
    delete process.env.N8NCTL_CLI_CREDENTIALS_FILE;
    delete process.env.N8NCTL_CLI_CONFIG_FILE;
    process.env.XDG_CONFIG_HOME = root;
    process.env.APPDATA = root;
    updateSettings({ account: "work" });

    getCredentialStore().setApiKey("work", "k1");

    const folder = dirname(new FileCredentialStore().path);
    expect(folder).toBe(join(root, "n8nctl-cli"));
    if (process.platform !== "win32") expect(statSync(folder).mode & 0o777).toBe(0o700);
  });

  it("does not change the mode of a folder someone else named", () => {
    if (process.platform === "win32") return;
    const shared = join(root, "shared");
    mkdirSync(shared, { mode: 0o755 });
    process.env.N8NCTL_CLI_CREDENTIALS_FILE = join(shared, "credentials.json");

    getCredentialStore().setApiKey("acct", "k1");

    expect(statSync(shared).mode & 0o777).toBe(0o755);
  });

  it("keeps other accounts when one changes, and removes the file when empty", () => {
    const store = getCredentialStore();
    store.setApiKey("a", "ka");
    store.setApiKey("b", "kb");
    store.setApiKey("a", "ka2");
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ "apiKey:a": "ka2", "apiKey:b": "kb" });
    store.deleteApiKey("a");
    store.deleteApiKey("b");
    expect(existsSync(file)).toBe(false);
  });

  it("treats an unreadable file as no key, not a crash", () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{not json");
    expect(getCredentialStore().getApiKey("acct")).toBeNull();
  });
});

describe("memory credential store", () => {
  it("is chosen by the environment and does not persist", () => {
    process.env.N8NCTL_CLI_CREDENTIAL_STORE = "memory";
    resetCredentialStore();
    const store = getCredentialStore();
    expect(store.kind).toBe("memory");
    expect(store.persistent).toBe(false);
    store.setApiKey("acct", "k1");
    expect(store.getApiKey("acct")).toBe("k1");
    store.deleteApiKey("acct");
    expect(store.getApiKey("acct")).toBeNull();
    expect(existsSync(file)).toBe(false);
  });
});

// A fake keychain, so these tests can never touch a real one.
describe("keychain with file fallback", () => {
  function fakeKeychain(behavior: "works" | "throws" | "drops-writes" = "works"): KeyStore & { keys: Map<string, string> } {
    const keys = new Map<string, string>();
    return {
      keys,
      getApiKey(account) {
        if (behavior === "throws") throw new Error("User interaction is not allowed.");
        return keys.get(account) ?? null;
      },
      setApiKey(account, apiKey) {
        if (behavior === "throws") throw new Error("User interaction is not allowed.");
        if (behavior === "works") keys.set(account, apiKey);
      },
      deleteApiKey(account) {
        if (behavior === "throws") throw new Error("User interaction is not allowed.");
        keys.delete(account);
      },
    };
  }

  it("uses the keychain and creates no file when the keychain works", () => {
    const keychain = fakeKeychain();
    const store = new KeyringWithFileFallback(keychain, new FileCredentialStore());
    expect(store.setApiKey("acct", "k1")).toBe("keyring");
    expect(keychain.keys.get("acct")).toBe("k1");
    expect(existsSync(file)).toBe(false);
    expect(store.getApiKey("acct")).toBe("k1");
  });

  it("uses the file when a closed keychain throws", () => {
    const store = new KeyringWithFileFallback(fakeKeychain("throws"), new FileCredentialStore());
    expect(store.setApiKey("acct", "k1")).toBe("file");
    expect(store.getApiKey("acct")).toBe("k1");
    expect(existsSync(file)).toBe(true);
  });

  it("reads the write back, so a keychain that drops writes falls back to the file", () => {
    const store = new KeyringWithFileFallback(fakeKeychain("drops-writes"), new FileCredentialStore());
    expect(store.setApiKey("acct", "k1")).toBe("file");
    expect(store.getApiKey("acct")).toBe("k1");
  });

  it("updates an existing file when a new key goes to the keychain", () => {
    const fileStore = new FileCredentialStore();
    fileStore.setApiKey("acct", "old");
    const store = new KeyringWithFileFallback(fakeKeychain(), fileStore);
    expect(store.setApiKey("acct", "new")).toBe("keyring");
    expect(fileStore.getApiKey("acct")).toBe("new");
  });

  it("clears the file even when the keychain cannot be cleared", () => {
    const store = new KeyringWithFileFallback(fakeKeychain("throws"), new FileCredentialStore());
    store.setApiKey("acct", "k1");
    store.deleteApiKey("acct");
    expect(store.getApiKey("acct")).toBeNull();
  });
});
