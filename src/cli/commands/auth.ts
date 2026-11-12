// `n8nctl auth` manages the stored API key from a script. People should use
// `login`, which checks the key first. The token is never printed back in full.

import pc from "picocolors";
import { getCredentialStore, getCredentialStoreInfo, storeLabel } from "../../auth.js";
import { passwordSlot, resolveConfig, resolvePassword, saveBaseUrl } from "../../config.js";
import { redact, UsageError } from "../../errors.js";
import { reporter } from "../output.js";

export type AuthOpts = {
  status?: boolean;
  login?: boolean;
  logout?: boolean;
  apiKey?: string;
  account?: string;
  baseUrl?: string;
  json?: boolean;
};

/**
 * Dispatch `n8nctl auth`. `--status` is checked first, so
 * `auth --status --api-key x` reports and writes nothing. Explicit intent wins.
 */
export async function authCommand(opts: AuthOpts): Promise<void> {
  if (opts.status) return authStatus(opts);
  if (opts.logout) return authLogout(opts);
  if (opts.login || opts.apiKey) return authLogin(opts);
  return authStatus(opts);
}

async function authLogin(opts: AuthOpts): Promise<void> {
  const apiKey = opts.apiKey || process.env.N8NCTL_API_KEY;
  if (!apiKey) {
    throw new UsageError(
      "No API key given.",
      "Run `n8nctl login`, or pass --api-key for automation."
    );
  }
  const { account } = resolveConfig({ account: opts.account });
  if (opts.baseUrl) {
    const { cleanAddress } = await import("./login.js");
    saveBaseUrl(account, cleanAddress(opts.baseUrl));
  }
  const store = getCredentialStore();
  const savedTo = store.setApiKey(account, apiKey) ?? store.kind;
  const r = reporter(opts);

  if (!store.persistent) {
    r.warn(
      pc.yellow(
        "Warning: this key will NOT persist after the process exits. " +
          "Use N8NCTL_API_KEY for automation."
      )
    );
  }
  r.result(
    { saved: true, account, apiKey: redact(apiKey), credentialStore: savedTo, persistent: store.persistent },
    `Saved API key for account "${account}" (${redact(apiKey)}) in your ${storeLabel(savedTo)}.`
  );
}

function authLogout(opts: AuthOpts): void {
  const { account } = resolveConfig({ account: opts.account });
  getCredentialStore().deleteApiKey(account);
  getCredentialStore().deleteApiKey(passwordSlot(account));
  reporter(opts).result(
    { cleared: true, account },
    `Cleared the API key and any saved n8n password for account "${account}".`
  );
}

function authStatus(opts: AuthOpts): void {
  const cfg = resolveConfig({ account: opts.account });
  const store = getCredentialStoreInfo();
  const status = {
    account: cfg.account,
    baseUrl: cfg.baseUrl,
    authenticated: Boolean(cfg.apiKey && cfg.baseUrl),
    apiKey: cfg.apiKey ? redact(cfg.apiKey) : null,
    email: cfg.email,
    editorPassword: Boolean(resolvePassword(cfg.account)),
    credentialStore: store.kind,
    persistent: store.persistent,
  };

  reporter(opts).result(
    status,
    [
      `Account:       ${status.account}`,
      `n8n address:   ${status.baseUrl ?? "not set"}`,
      `Authenticated: ${status.authenticated ? "yes" : "no"}`,
      ...(status.apiKey ? [`API key:       ${status.apiKey}`] : []),
      `Email sign-in: ${status.email && status.editorPassword ? status.email : "not set (needed only for archive, unarchive and run)"}`,
      `Store:         ${status.credentialStore} (persistent: ${status.persistent})`,
    ].join("\n")
  );
}
