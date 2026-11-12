import { configDir } from "./paths.js";
import { ConfigError, fileErrorReason } from "./errors.js";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const SERVICE = "n8nctl-cli";
const require = createRequire(import.meta.url);

export type StoreKind = "keyring" | "file" | "memory";

export interface CredentialStore {
  readonly kind: StoreKind;
  readonly persistent: boolean;
  getApiKey(account: string): string | null;
  /** Returns where the key went, which can differ from `kind` for the chained store. */
  setApiKey(account: string, apiKey: string): StoreKind | void;
  deleteApiKey(account: string): void;
}

/** The part of a store the chained store needs. Tests pass a fake keychain here. */
export type KeyStore = Pick<CredentialStore, "getApiKey" | "setApiKey" | "deleteApiKey">;

function accountKey(account: string): string {
  return `apiKey:${account}`;
}

class KeyringCredentialStore implements KeyStore {
  private Entry: typeof import("@napi-rs/keyring").Entry;

  constructor() {
    this.Entry = require("@napi-rs/keyring").Entry;
  }

  private entry(account: string) {
    return new this.Entry(SERVICE, accountKey(account));
  }

  getApiKey(account: string): string | null {
    return this.entry(account).getPassword();
  }

  setApiKey(account: string, apiKey: string): void {
    this.entry(account).setPassword(apiKey);
  }

  deleteApiKey(account: string): void {
    this.entry(account).deletePassword();
  }
}

export function credentialsFilePath(): string {
  return (
    process.env.N8NCTL_CLI_CREDENTIALS_FILE ||
    join(configDir(), "credentials.json")
  );
}

/**
 * A private file for the key, readable only by its owner.
 *
 * The keychain is closed to SSH sessions on macOS: reads come back empty and
 * writes fail with "User interaction is not allowed". Linux servers often have
 * no keychain service at all. Without this file, those sessions could not sign in.
 *
 * On Windows the mode bits below have no effect. There the file relies on the
 * permissions of the user's profile folder, and Credential Manager is normally
 * available, so the file is rarely used.
 */
export class FileCredentialStore implements CredentialStore {
  readonly kind = "file" as const;
  readonly persistent = true;

  get path(): string {
    return credentialsFilePath();
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  /**
   * A read for a lookup treats a damaged file as empty. A read before a write
   * is strict: writing over a damaged file would drop the keys for other accounts.
   */
  private read(strict = false): Record<string, string> {
    if (!this.exists()) return {};
    try {
      const data = JSON.parse(readFileSync(this.path, "utf-8"));
      if (data && typeof data === "object" && !Array.isArray(data)) return data;
    } catch (error) {
      if (strict && !(error instanceof SyntaxError)) {
        throw new ConfigError(`Cannot read the credentials file: ${fileErrorReason(error)}.`, `Credentials file: ${this.path}`);
      }
    }
    if (!strict) return {};
    throw new ConfigError(
      "The credentials file is damaged, so the CLI will not write over the keys in it.",
      `Move or delete ${this.path}, then run \`n8nctl login\`.`
    );
  }

  private write(data: Record<string, string>): void {
    const dir = dirname(this.path);
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Saving settings can create this CLI's folder first, with the default mode.
      // Tighten that folder only. A folder someone named through the environment
      // variable is theirs, and may hold other files.
      if (dir === configDir()) chmodSync(dir, 0o700);
      writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw new ConfigError(
        `Cannot save the credentials file: ${fileErrorReason(error)}.`,
        `Credentials file: ${this.path}. Check you can write to that folder, or set N8NCTL_API_KEY instead.`
      );
    }
  }

  getApiKey(account: string): string | null {
    const val = this.read()[accountKey(account)];
    return typeof val === "string" && val.length > 0 ? val : null;
  }

  setApiKey(account: string, apiKey: string): "file" {
    this.write({ ...this.read(true), [accountKey(account)]: apiKey });
    return "file";
  }

  deleteApiKey(account: string): void {
    const data = this.read(true);
    delete data[accountKey(account)];
    if (Object.keys(data).length === 0) rmSync(this.path, { force: true });
    else this.write(data);
  }
}

/**
 * The keychain first, the private file when the keychain cannot be used.
 *
 * A write goes to the keychain and is read back, because a blocked keychain
 * can accept a write silently and then return nothing. When that fails, the
 * key goes to the file. When a file already exists, it is updated too, so a
 * new key saved from the desktop does not leave SSH sessions on the old one.
 */
export class KeyringWithFileFallback implements CredentialStore {
  readonly kind = "keyring" as const;
  readonly persistent = true;

  constructor(
    private readonly keyring: KeyStore,
    private readonly file: FileCredentialStore
  ) {}

  getApiKey(account: string): string | null {
    let fromKeyring: string | null = null;
    try {
      fromKeyring = this.keyring.getApiKey(account);
    } catch {
      fromKeyring = null;
    }
    return fromKeyring ?? this.file.getApiKey(account);
  }

  setApiKey(account: string, apiKey: string): "keyring" | "file" {
    let inKeyring = false;
    try {
      this.keyring.setApiKey(account, apiKey);
      inKeyring = this.keyring.getApiKey(account) === apiKey;
    } catch {
      inKeyring = false;
    }
    if (!inKeyring || this.file.exists()) this.file.setApiKey(account, apiKey);
    return inKeyring ? "keyring" : "file";
  }

  deleteApiKey(account: string): void {
    try {
      this.keyring.deleteApiKey(account);
    } catch {
      // A blocked keychain cannot be cleared from here. The file still can be.
    }
    this.file.deleteApiKey(account);
  }
}

class MemoryCredentialStore implements CredentialStore {
  readonly kind = "memory" as const;
  readonly persistent = false;
  private store = new Map<string, string>();

  getApiKey(account: string): string | null {
    return this.store.get(accountKey(account)) ?? null;
  }

  setApiKey(account: string, apiKey: string): void {
    this.store.set(accountKey(account), apiKey);
  }

  deleteApiKey(account: string): void {
    this.store.delete(accountKey(account));
  }
}

let cachedStore: CredentialStore | null = null;

export function getCredentialStore(): CredentialStore {
  if (cachedStore) return cachedStore;

  if (process.env.N8NCTL_CLI_CREDENTIAL_STORE === "memory") {
    cachedStore = new MemoryCredentialStore();
    return cachedStore;
  }

  if (process.env.N8NCTL_CLI_CREDENTIAL_STORE === "file") {
    cachedStore = new FileCredentialStore();
    return cachedStore;
  }

  try {
    require.resolve("@napi-rs/keyring");
    const keyring = new KeyringCredentialStore();
    keyring.getApiKey("__cli_probe__"); // a real keychain read, to confirm it works
    cachedStore = new KeyringWithFileFallback(keyring, new FileCredentialStore());
  } catch {
    cachedStore = new FileCredentialStore();
  }

  return cachedStore;
}

export function getCredentialStoreInfo(): { kind: StoreKind; persistent: boolean } {
  const store = getCredentialStore();
  return { kind: store.kind, persistent: store.persistent };
}

/** A plain name for where a key went, for messages to the user. */
export function storeLabel(kind: StoreKind): string {
  if (kind === "file") return `private credentials file (${credentialsFilePath()})`;
  if (kind !== "keyring") return "session (not saved)";
  if (process.platform === "darwin") return "macOS Keychain";
  if (process.platform === "win32") return "Windows Credential Manager";
  return "OS keyring";
}

/** Test seam: drop the cached store so a test can resolve it again. */
export function resetCredentialStore(): void {
  cachedStore = null;
}
