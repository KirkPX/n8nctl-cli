// The second and third ways this CLI talks to n8n.
//
// EditorClient: n8n's editor API (/rest), signed in with a person's own email and
// password. n8n's public API cannot archive a workflow or run one the way the editor's
// "Execute workflow" button does, and the editor API refuses API keys. These endpoints
// are not part of n8n's documented API, so a new n8n version can change them. They were
// read from n8n 2.x (packages/cli/src/workflows/workflows.controller.ts).
//
// WebhookClient: a workflow's own public webhook address. It sends no key at all.
//
// Both reuse ApiClient's request(), so they have the same time limit, retry rules,
// redirect refusal and typed errors.

import { randomUUID } from "node:crypto";
import { ApiClient, type ClientOptions, type RequestMethod } from "./client.js";
import { LoginError } from "./errors.js";

type Session = { cookie: string; browserId: string };

export type EditorLogin = { email: string; password: string; mfaCode?: string };

export class EditorClient extends ApiClient {
  private constructor(
    options: Omit<ClientOptions, "apiKey">,
    private readonly session: Session
  ) {
    // The session cookie stands where the key would be, so error text never shows it.
    super({ ...options, apiKey: session.cookie });
  }

  /**
   * Sign in to the editor and keep the session for this command. n8n ties the cookie
   * to the `browser-id` header sent at sign-in, so every later call sends the same one.
   */
  static async login(options: Omit<ClientOptions, "apiKey">, login: EditorLogin): Promise<EditorClient> {
    const browserId = `n8nctl-${randomUUID()}`;
    const anon = new AnonymousClient(options);
    const body: Record<string, string> = { emailOrLdapLoginId: login.email, password: login.password };
    if (login.mfaCode) body.mfaCode = login.mfaCode;
    const res = await anon.request<Record<string, unknown>>("/rest/login", {
      method: "POST",
      body,
      headers: { "browser-id": browserId },
      anyStatus: true,
    });
    if (res.status !== 200) {
      const reason = typeof res.data?.message === "string" ? res.data.message : `HTTP ${res.status}`;
      if (/mfa/i.test(reason)) {
        throw new LoginError(
          `n8n asks for a two-step code for ${login.email}.`,
          "Run the command again with --mfa-code <code> from your authenticator app."
        );
      }
      throw new LoginError(
        `n8n refused the sign-in for ${login.email}: ${reason}.`,
        "Check the email and password with `n8nctl login --email --force`. If your n8n signs in only through SSO, these commands are not available to you."
      );
    }
    const cookie = getSetCookies(res.headers)
      .map((c) => c.split(";")[0] ?? "")
      .find((c) => c.startsWith("n8n-auth="));
    if (!cookie) throw new LoginError("n8n accepted the sign-in but sent no session cookie.");
    return new EditorClient(options, { cookie, browserId });
  }

  protected override authHeader(): Record<string, string> {
    return { Cookie: this.session.cookie, "browser-id": this.session.browserId };
  }

  protected override hintFor(status: number): string | undefined {
    if (status === 401) return "The editor session ended. Run the command again.";
    if (status === 403) return "Your n8n user is not allowed to do this to that workflow.";
    return undefined;
  }

  private async editor<T>(method: RequestMethod, path: string, body?: unknown): Promise<T> {
    const { data } = await this.request<{ data?: T } & T>(`/rest${path}`, {
      method,
      ...(body !== undefined ? { body } : {}),
      timeoutMs: 60_000,
    });
    return ((data as { data?: T } | null)?.data ?? data) as T;
  }

  /** The request the editor's "Execute workflow" button sends. */
  async runManually(workflowId: string, payload: unknown): Promise<{ executionId?: string; waitingForWebhook?: boolean }> {
    return await this.editor("POST", `/workflows/${encodeURIComponent(workflowId)}/run`, payload);
  }

  /** Archive a workflow, as the editor's menu does. It stays in n8n and can be restored. */
  async archiveWorkflow(workflowId: string): Promise<unknown> {
    return await this.editor("POST", `/workflows/${encodeURIComponent(workflowId)}/archive`, {});
  }

  /** Bring an archived workflow back. It stays switched off. */
  async unarchiveWorkflow(workflowId: string): Promise<unknown> {
    return await this.editor("POST", `/workflows/${encodeURIComponent(workflowId)}/unarchive`, {});
  }

  /** Stop the editor waiting for a test call. n8n also gives up by itself after two minutes. */
  async cancelTestWebhook(workflowId: string): Promise<unknown> {
    return await this.editor("DELETE", `/test-webhook/${encodeURIComponent(workflowId)}`);
  }
}

/** A client that sends no credential, for sign-in and for public webhooks. */
class AnonymousClient extends ApiClient {
  constructor(options: Omit<ClientOptions, "apiKey">) {
    super({ ...options, apiKey: "" });
  }

  protected override authHeader(): Record<string, string> {
    return {};
  }
}

export class WebhookClient extends AnonymousClient {
  /**
   * Call a workflow's production webhook. Any HTTP status comes back as the result,
   * because the webhook's answer is what the person asked to see.
   */
  async call(opts: { method: string; path: string; data?: unknown; timeoutMs?: number }): Promise<{ status: number; data: unknown }> {
    const method = opts.method.toUpperCase() as RequestMethod;
    const isGet = method === "GET";
    const params: Record<string, string> = {};
    if (isGet && opts.data && typeof opts.data === "object") {
      for (const [k, v] of Object.entries(opts.data)) params[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    const res = await this.request(`/webhook/${opts.path.split("/").map(encodeURIComponent).join("/")}`, {
      method,
      params,
      ...(isGet ? {} : { body: opts.data ?? {} }),
      timeoutMs: opts.timeoutMs ?? 300_000,
      anyStatus: true,
    });
    return { status: res.status, data: res.data };
  }
}

function getSetCookies(headers: Headers): string[] {
  const withList = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withList.getSetCookie === "function") return withList.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

