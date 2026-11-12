// `n8nctl login` signs in to one n8n. n8n offers two ways in, and the CLI offers both:
//
//   login           an API key (n8n: Settings > n8n API). Every command uses it.
//   login --email   your own n8n email and password. Only `archive`, `unarchive` and
//                   `run` need it, because n8n's API key cannot do those.
//
// n8n is self-hosted, so there is no address to work out from the key: sign-in asks
// for it once and saves it. `--account` names a second n8n.
import pc from "picocolors";
import { getCredentialStore, storeLabel, type StoreKind } from "../../auth.js";
import { ApiClient } from "../../client.js";
import { EditorClient } from "../../client-editor.js";
import { passwordSlot, resolveConfig, resolvePassword, saveBaseUrl, saveEmail } from "../../config.js";
import { ApiError, LoginError, NetworkError, TimeoutError, UsageError } from "../../errors.js";
import { runBrowserLogin } from "../../login/server.js";
import { promptLine, promptSecret } from "../../login/prompt.js";
import { reporter } from "../output.js";

export type LoginOpts = {
  json?: boolean;
  paste?: boolean;
  force?: boolean;
  email?: boolean;
  mfaCode?: string;
  account?: string;
  baseUrl?: string;
};

type Verified = { account: string; baseUrl: string; identity: string; credentialStore: StoreKind };

export async function loginCommand(opts: LoginOpts = {}): Promise<void> {
  if (opts.email) return await emailLogin(opts);
  const r = reporter(opts);
  const cfg = resolveConfig({ account: opts.account, baseUrl: opts.baseUrl });

  if (!opts.force && cfg.apiKey && cfg.baseUrl) {
    r.result(
      { loggedIn: true, account: cfg.account, baseUrl: cfg.baseUrl, changed: false },
      `Already signed in to ${cfg.baseUrl} (${cfg.account}).\n` + pc.dim("Run `n8nctl login --force` to sign in again.")
    );
    return;
  }

  const verified =
    opts.paste || !canUseBrowser()
      ? await pasteLogin(cfg.account, cfg.baseUrl)
      : await runBrowserLogin<Verified>({
          baseUrl: cfg.baseUrl,
          accept: (key, address) => verifyKey(key, address ?? cfg.baseUrl ?? "", cfg.account),
        });

  const { persistent } = getCredentialStore();
  if (!persistent) {
    r.warn(pc.yellow("Warning: this key will not persist after the process exits. Use N8NCTL_API_KEY for automation."));
  }
  r.result(
    { loggedIn: true, ...verified, persistent },
    `${pc.green("Signed in")} to ${verified.identity}.\n` +
      pc.dim(`Key saved to your ${storeLabel(verified.credentialStore)}.`) +
      "\n\nTry it: " +
      pc.cyan("n8nctl list")
  );
}

export async function logoutCommand(opts: LoginOpts = {}): Promise<void> {
  const { account } = resolveConfig({ account: opts.account });
  const store = getCredentialStore();
  store.deleteApiKey(account);
  store.deleteApiKey(passwordSlot(account));
  reporter(opts).result(
    { cleared: true, account },
    pc.green(`Signed out (${account}). The API key and any saved n8n password are removed.`)
  );
}

/** True when a usable key and address are already on hand. */
export function isConfigured(): boolean {
  const cfg = resolveConfig();
  return Boolean(cfg.apiKey && cfg.baseUrl);
}

async function pasteLogin(account: string, known: string | null): Promise<Verified> {
  const address = known ?? (await promptLine("n8n address (such as https://n8n.example.com): "));
  if (!address) throw new LoginError("No n8n address entered.");
  const key = await promptSecret("Paste your n8n API key (Settings > n8n API): ");
  if (!key) throw new LoginError("Nothing entered.");
  return await verifyKey(key, address, account);
}

/** The address as n8n's root, with no trailing slash and no /api/v1 copied from a docs page. */
export function cleanAddress(raw: string): string {
  const text = raw.trim().replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new LoginError(`"${raw}" is not a web address.`, "Type it the way your browser shows it, such as https://n8n.example.com.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LoginError(`"${raw}" is not a web address.`, "It starts with https:// or http://.");
  }
  return text;
}

/**
 * Prove the key works, THEN store it. One small read of the workflow list is enough:
 * n8n answers 401 to a wrong key. Storing first would report a typo as success.
 */
async function verifyKey(raw: string, rawAddress: string, account: string): Promise<Verified> {
  const key = raw.trim();
  if (!key) throw new LoginError("Nothing entered.");
  if (!rawAddress.trim()) throw new LoginError("Enter the n8n address.");
  const baseUrl = cleanAddress(rawAddress);
  try {
    await new ApiClient({ baseUrl, apiKey: key, maxRetries: 1 }).request("/api/v1/workflows", { params: { limit: 1 } });
  } catch (error) {
    throw explain(error, baseUrl);
  }
  const store = getCredentialStore();
  const credentialStore = store.setApiKey(account, key) ?? store.kind;
  saveBaseUrl(account, baseUrl);
  return { account, baseUrl, identity: new URL(baseUrl).host, credentialStore };
}

function explain(error: unknown, baseUrl: string): Error {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return new LoginError(
        `${new URL(baseUrl).host} refused that API key (${error.safeDetail}).`,
        "Copy the key again from Settings > n8n API. If the key is right, check the address is the n8n it belongs to."
      );
    }
    if (error.status === 404) {
      return new LoginError(
        `${baseUrl} has no n8n API at /api/v1.`,
        "Check the address. The public API can also be switched off in n8n's settings."
      );
    }
    return new LoginError(`${baseUrl} answered ${error.status}: ${error.safeDetail}.`);
  }
  if (error instanceof NetworkError || error instanceof TimeoutError) {
    return new LoginError(`Cannot reach ${baseUrl}: ${error.message}`, "Check the address and your connection.");
  }
  return error instanceof Error ? error : new LoginError(String(error));
}

/**
 * Sign in with your own n8n email and password, check them against n8n, then save
 * the email in the settings file and the password in the credential store.
 */
async function emailLogin(opts: LoginOpts): Promise<void> {
  const r = reporter(opts);
  const cfg = resolveConfig({ account: opts.account, baseUrl: opts.baseUrl });
  if (!opts.force && cfg.email && resolvePassword(cfg.account)) {
    r.result(
      { loggedIn: true, account: cfg.account, email: cfg.email, changed: false },
      `Already signed in as ${cfg.email} (${cfg.account}).\n` + pc.dim("Run `n8nctl login --email --force` to sign in again.")
    );
    return;
  }
  const address = cfg.baseUrl ?? (await promptLine("n8n address (such as https://n8n.example.com): "));
  if (!address) throw new LoginError("No n8n address entered.");
  const baseUrl = cleanAddress(address);
  const email = (await promptLine(`n8n email${cfg.email ? ` [${cfg.email}]` : ""}: `)) || cfg.email || "";
  if (!email) throw new UsageError("No email entered.");
  const password = await promptSecret("n8n password: ");
  if (!password) throw new LoginError("No password entered.");

  try {
    await EditorClient.login({ baseUrl, maxRetries: 1 }, { email, password, mfaCode: opts.mfaCode });
  } catch (error) {
    if (error instanceof LoginError) throw error;
    throw explain(error, baseUrl);
  }
  const store = getCredentialStore();
  const credentialStore = store.setApiKey(passwordSlot(cfg.account), password) ?? store.kind;
  saveBaseUrl(cfg.account, baseUrl);
  saveEmail(cfg.account, email);
  r.result(
    { loggedIn: true, account: cfg.account, baseUrl, email, credentialStore },
    `${pc.green("Signed in")} as ${email} on ${new URL(baseUrl).host}.\n` +
      pc.dim(`Password saved to your ${storeLabel(credentialStore)}. archive, unarchive and run can use it now.`) +
      (opts.mfaCode
        ? "\n" + pc.yellow("Two-step sign-in is on, so archive, unarchive and run each need --mfa-code too.")
        : "")
  );
}

function canUseBrowser(): boolean {
  // No terminal to return to, or an explicitly headless environment: the
  // browser has nowhere to open.
  if (process.env.N8NCTL_CLI_NO_BROWSER) return false;
  return process.stdout.isTTY === true;
}
