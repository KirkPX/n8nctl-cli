import { getCredentialStore } from "./auth.js";
import { ConfigError } from "./errors.js";
import { settingsFilePath } from "./paths.js";
import { loadSettings, updateSettings, type Settings } from "./settings.js";

const DEFAULT_ACCOUNT = "default";
const DEFAULT_WORKFLOWS_DIR = "workflows";

export type ResolveOptions = {
  baseUrl?: string;
  apiKey?: string;
  account?: string;
};

export type ResolvedConfig = {
  /** The n8n address. n8n is self-hosted, so there is no default: sign-in asks for it. */
  baseUrl: string | null;
  apiKey: string | null;
  account: string;
  email: string | null;
  timeoutMs?: number;
  workflowsDir: string;
};

/**
 * The single precedence chain: flags > env > settings file / keychain > default.
 * For the address and the email, an account's own setting beats the shared one.
 *
 * `settings` can be passed in so `doctor` can use this chain after a broken
 * settings file. Every other caller lets a broken file stop the command.
 */
export function resolveConfig(opts: ResolveOptions = {}, settings: Settings = loadSettings()): ResolvedConfig {
  const account = opts.account || env("N8NCTL_ACCOUNT") || settings.account || DEFAULT_ACCOUNT;
  const own = settings.accounts?.[account];
  const baseUrl =
    opts.baseUrl || env("N8NCTL_BASE_URL") || own?.baseUrl || settings.baseUrl || null;
  const apiKey = opts.apiKey || env("N8NCTL_API_KEY") || getCredentialStore().getApiKey(account) || null;
  const email = env("N8NCTL_EMAIL") || own?.email || settings.email || null;
  const workflowsDir = env("N8NCTL_WORKFLOWS_DIR") || settings.workflowsDir || DEFAULT_WORKFLOWS_DIR;
  return { baseUrl, apiKey, account, email, timeoutMs: settings.timeoutMs, workflowsDir };
}

/** The editor password: N8NCTL_PASSWORD, or the one `login --email` saved. */
export function resolvePassword(account: string): string | null {
  return env("N8NCTL_PASSWORD") || getCredentialStore().getApiKey(passwordSlot(account)) || null;
}

/**
 * Where the editor password is kept: the same store as the API key, under its own
 * name, so the keychain, the private-file fallback and logout all cover it.
 */
export function passwordSlot(account: string): string {
  return `${account}#editor-password`;
}

/**
 * Save the address for this account. The first account to sign in sets the shared
 * address; another account with a different address keeps its own.
 */
export function saveBaseUrl(account: string, baseUrl: string): void {
  const settings = loadSettings();
  if (!settings.baseUrl || settings.baseUrl === baseUrl) {
    updateSettings({ baseUrl });
    return;
  }
  updateSettings({ accounts: { ...settings.accounts, [account]: { ...settings.accounts?.[account], baseUrl } } });
}

/** Save the email the same way as the address. */
export function saveEmail(account: string, email: string): void {
  const settings = loadSettings();
  if (!settings.email || settings.email === email) {
    updateSettings({ email });
    return;
  }
  updateSettings({ accounts: { ...settings.accounts, [account]: { ...settings.accounts?.[account], email } } });
}

export function requireBaseUrl(baseUrl: string | null): asserts baseUrl is string {
  if (!baseUrl) {
    throw new ConfigError(
      "No n8n address is set.",
      "Run `n8nctl login`, or `n8nctl config set baseUrl https://your-n8n.example.com`, or set N8NCTL_BASE_URL."
    );
  }
}

export function setBaseUrl(baseUrl: string): void {
  updateSettings({ baseUrl });
}

export function setAccount(account: string): void {
  updateSettings({ account });
}

/** Where the settings file lives. `doctor` and `config path` print it. */
export function getConfigPath(): string {
  return settingsFilePath();
}

function env(name: string): string | undefined {
  const val = process.env[name];
  return val && val.length > 0 ? val : undefined;
}
