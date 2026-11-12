import { ApiClient, type RetryInfo } from "../client.js";
import { EditorClient, WebhookClient } from "../client-editor.js";
import { requireBaseUrl, resolveConfig, resolvePassword } from "../config.js";
import { ConfigError } from "../errors.js";
import { requireApiKey } from "./guardrails.js";
import { reporter, type Reporter } from "./output.js";

export type ClientOpts = { json?: boolean; account?: string; baseUrl?: string };

/**
 * The client a command uses: settings resolved, sign-in required, retries shown.
 * A retry message goes to stderr at a terminal, and stays out of a piped run.
 */
export function createClient(opts: ClientOpts & { minIntervalMs?: number } = {}): ApiClient {
  const cfg = resolveConfig({ account: opts.account, baseUrl: opts.baseUrl });
  requireBaseUrl(cfg.baseUrl);
  requireApiKey(cfg.apiKey);
  const r = reporter(opts);
  return new ApiClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
    minIntervalMs: opts.minIntervalMs,
    onRetry: (info) => reportRetry(r, info),
  });
}

/**
 * An editor session, for the commands n8n's public API cannot do. It signs in with
 * the email and password saved by `n8nctl login --email`, or N8NCTL_EMAIL and
 * N8NCTL_PASSWORD.
 */
export async function createEditor(opts: ClientOpts & { mfaCode?: string }, command: string): Promise<EditorClient> {
  const cfg = resolveConfig({ account: opts.account, baseUrl: opts.baseUrl });
  requireBaseUrl(cfg.baseUrl);
  const password = resolvePassword(cfg.account);
  if (!cfg.email || !password) {
    throw new ConfigError(
      `${command} needs your own n8n sign-in, because n8n's API key cannot do it.`,
      "Run `n8nctl login --email` once, or set N8NCTL_EMAIL and N8NCTL_PASSWORD."
    );
  }
  const r = reporter(opts);
  return await EditorClient.login(
    { baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs, onRetry: (info) => reportRetry(r, info) },
    { email: cfg.email, password, mfaCode: opts.mfaCode }
  );
}

/** A client for a workflow's public webhook. It needs the address, not a key. */
export function createWebhookClient(opts: ClientOpts = {}): WebhookClient {
  const cfg = resolveConfig({ account: opts.account, baseUrl: opts.baseUrl });
  requireBaseUrl(cfg.baseUrl);
  const r = reporter(opts);
  return new WebhookClient({ baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs, onRetry: (info) => reportRetry(r, info) });
}

function reportRetry(r: Reporter, info: RetryInfo): void {
  const seconds = Math.ceil(info.delayMs / 1000);
  r.note(
    `n8n answered ${info.status} for ${info.operation}. Retrying in ${seconds}s (${info.attempt + 1}/${info.maxRetries}).`
  );
}
