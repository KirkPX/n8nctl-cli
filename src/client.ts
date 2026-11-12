// The client for n8n's public API (/api/v1), signed in with an API key. One place talks
// to n8n, so timeout, retry, the key and error redaction are the same for every command.
// Every request has a time limit; retries are limited and shown; errors carry the
// operation, the status and n8n's own reason. Every answer is checked for the shape the
// commands read (src/workflow/shape.ts).

import { ApiError, NetworkError, TimeoutError, UsageError } from "./errors.js";
import * as shape from "./workflow/shape.js";
import type { Execution, Tag, Workflow } from "./workflow/types.js";

export type ClientOptions = {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Wait at least this long between requests, so a long job does not crowd out running workflows. */
  minIntervalMs?: number;
  onRetry?: (info: RetryInfo) => void;
};

export type RetryInfo = {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  status: number;
  operation: string;
};

export type RequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RequestOptions = {
  method?: RequestMethod;
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** A longer limit for one request, such as a page of full workflows. */
  timeoutMs?: number;
  /** Return any HTTP status instead of throwing, for a webhook whose answer is the result. */
  anyStatus?: boolean;
};

export type ApiResponse<T = unknown> = {
  status: number;
  data: T | null;
  headers: Headers;
};

export class ApiClient {
  private readonly baseUrl: string;
  protected readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly minIntervalMs: number;
  private readonly onRetry?: (info: RetryInfo) => void;
  private lastRequestAt = 0;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.onRetry = options.onRetry;
  }

  /** The n8n instance this client talks to. */
  get instance(): string {
    return this.baseUrl;
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    const { method = "GET", body, params, headers: extraHeaders } = opts;
    const url = buildUrl(this.baseUrl, path, params);
    const operation = `${method} ${path}`;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    for (let attempt = 1; ; attempt++) {
      await this.pace();
      const { response, data } = await this.fetchWithTimeout(url, operation, timeoutMs, {
        method,
        headers: {
          Accept: "application/json",
          ...this.authHeader(),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...extraHeaders,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        // The key travels in a custom header, and fetch keeps custom headers on a
        // redirect to another host. So no redirect is followed.
        redirect: "manual",
      });

      if (response.status >= 300 && response.status < 400) {
        throw new ApiError({
          status: response.status,
          statusText: response.statusText,
          operation,
          safeDetail: `n8n sent the request on to ${response.headers.get("location") ?? "another address"}`,
          hint: "Set the n8n address to where it ends up, such as https:// in place of http://: `n8nctl config set baseUrl <url>`.",
        });
      }

      if (response.ok) {
        return { status: response.status, data: data as T | null, headers: response.headers };
      }

      if (isRetryable(response.status, method) && attempt < this.maxRetries) {
        const delayMs = retryDelayMs(response, attempt, this.retryBaseDelayMs);
        this.onRetry?.({ attempt, maxRetries: this.maxRetries, delayMs, status: response.status, operation });
        await sleep(delayMs);
        continue;
      }

      if (opts.anyStatus) return { status: response.status, data: data as T | null, headers: response.headers };

      throw new ApiError({
        status: response.status,
        statusText: response.statusText,
        operation,
        safeDetail: extractSafeDetail(data, this.apiKey),
        hint: this.hintFor(response.status),
      });
    }
  }

  /** A next step that differs from the general one for this status, or undefined. */
  protected hintFor(_status: number): string | undefined {
    return undefined;
  }

  private async pace(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  /**
   * Send one request and read its reply, both inside one time limit. A reply that
   * starts quickly and then stalls is stopped too, not only one that never starts.
   */
  private async fetchWithTimeout(
    url: string,
    operation: string,
    timeoutMs: number,
    init: RequestInit
  ): Promise<{ response: Response; data: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return { response, data: await parseResponseBody(response) };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new TimeoutError({ operation, timeoutMs });
      }
      // fetch reports every network failure as "fetch failed", with the reason,
      // such as ENOTFOUND, on `cause`.
      if (error instanceof TypeError) {
        throw new NetworkError({ operation, host: new URL(url).host, cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** n8n's public API reads the key from this header. */
  protected authHeader(): Record<string, string> {
    return { "X-N8N-API-KEY": this.apiKey };
  }

  // ── Endpoints ─────────────────────────────────────────────────────────────

  /** Follow `nextCursor` until the list ends, or until `max` items. */
  private async allPages(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    opts: { max?: number; pageSize?: number; timeoutMs?: number } = {}
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    const operation = `GET ${path}`;
    let cursor: string | undefined;
    do {
      const room = opts.max ? opts.max - out.length : Infinity;
      const limit = Math.min(opts.pageSize ?? 250, room);
      const { data } = await this.request(path, { params: { ...params, limit, cursor }, timeoutMs: opts.timeoutMs });
      const page = shape.page(data, operation);
      out.push(...page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && (!opts.max || out.length < opts.max));
    // n8n's cursor carries the first page's size and ignores a new `limit` beside it,
    // so a later page can bring more than asked for. Checked on a live server.
    return opts.max ? out.slice(0, opts.max) : out;
  }

  /**
   * Every workflow the key can see, archived ones included, each with its nodes.
   * `active` and `tags` are filters n8n applies; both were checked on a live server.
   */
  async listWorkflows(filters: { active?: boolean; tags?: string[] } = {}): Promise<Workflow[]> {
    const params = {
      active: filters.active,
      tags: filters.tags?.length ? filters.tags.join(",") : undefined,
    };
    // A page of full workflows is large, so it gets more time than one small request.
    const items = await this.allPages("/api/v1/workflows", params, { timeoutMs: Math.max(this.timeoutMs, 60_000) });
    return shape.workflowList(items, "GET /api/v1/workflows");
  }

  async getWorkflow(id: string): Promise<Workflow> {
    const path = `/api/v1/workflows/${encodeURIComponent(id)}`;
    const { data } = await this.request(path);
    return shape.workflowDetail(data, `GET ${path}`, id);
  }

  async createWorkflow(body: Record<string, unknown>): Promise<Workflow> {
    const { data } = await this.request("/api/v1/workflows", { method: "POST", body });
    return shape.workflowSummary(data, "POST /api/v1/workflows");
  }

  async updateWorkflow(id: string, body: Record<string, unknown>): Promise<Workflow> {
    const path = `/api/v1/workflows/${encodeURIComponent(id)}`;
    const { data } = await this.request(path, { method: "PUT", body });
    return shape.workflowSummary(data, `PUT ${path}`);
  }

  async deleteWorkflow(id: string): Promise<void> {
    await this.request(`/api/v1/workflows/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async activateWorkflow(id: string): Promise<void> {
    await this.request(`/api/v1/workflows/${encodeURIComponent(id)}/activate`, { method: "POST" });
  }

  async deactivateWorkflow(id: string): Promise<void> {
    await this.request(`/api/v1/workflows/${encodeURIComponent(id)}/deactivate`, { method: "POST" });
  }

  async listTags(): Promise<Tag[]> {
    const items = await this.allPages("/api/v1/tags", {}, { pageSize: 100 });
    return items.map((t) => shape.tag(t, "GET /api/v1/tags"));
  }

  async createTag(name: string): Promise<Tag> {
    const { data } = await this.request("/api/v1/tags", { method: "POST", body: { name } });
    return shape.tag(data, "POST /api/v1/tags");
  }

  /** n8n removes a deleted tag from every workflow that has it, archived ones too. */
  async deleteTag(id: string): Promise<void> {
    await this.request(`/api/v1/tags/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** Replace a workflow's tags. The workflow itself, and whether it is on, stay as they are. */
  async setWorkflowTags(id: string, tagIds: string[]): Promise<Tag[]> {
    const path = `/api/v1/workflows/${encodeURIComponent(id)}/tags`;
    const { data } = await this.request(path, { method: "PUT", body: tagIds.map((tagId) => ({ id: tagId })) });
    if (!Array.isArray(data)) throw new shape.ShapeError(`PUT ${path}`, "expected a list of tags");
    return data.map((t) => shape.tag(t, `PUT ${path}`));
  }

  /**
   * Recent runs, newest first. n8n keeps runs only as long as its own settings say.
   * `workflowId`, `status` and `limit` were each checked on a live server.
   */
  async listExecutions(filters: { workflowId?: string; status?: string; limit: number }): Promise<Execution[]> {
    const items = await this.allPages(
      "/api/v1/executions",
      { workflowId: filters.workflowId, status: filters.status },
      { max: filters.limit, pageSize: 250 }
    );
    return items.map((e) => shape.execution(e, "GET /api/v1/executions"));
  }

  async getExecution(id: string, opts: { includeData?: boolean } = {}): Promise<Execution> {
    const path = `/api/v1/executions/${encodeURIComponent(id)}`;
    const { data } = await this.request(path, { params: { includeData: opts.includeData || undefined } });
    return shape.execution(data, `GET ${path}`);
  }

  /** Run a failed execution again with its input. `loadWorkflow` uses the workflow as it is now. */
  async retryExecution(id: string, opts: { loadWorkflow?: boolean } = {}): Promise<Execution> {
    const path = `/api/v1/executions/${encodeURIComponent(id)}/retry`;
    const { data } = await this.request(path, { method: "POST", body: { loadWorkflow: Boolean(opts.loadWorkflow) } });
    return shape.execution(data, `POST ${path}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * The full address for a request. It must stay on the signed-in n8n, because every
 * request carries the API key. A path such as `//other.example/x`, or a full address
 * elsewhere, would otherwise send the key to that host.
 *
 * A path with one leading slash stays under the base URL, so `/api/v1/workflows` on
 * `https://example.com/n8n` is `/n8n/api/v1/workflows`, for an n8n served under a path.
 */
export function buildUrl(
  base: string,
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): string {
  let root: URL;
  let url: URL;
  try {
    root = new URL(base.replace(/\/*$/, "/"));
    url = new URL(/^\/(?![/\\])/.test(path) ? path.slice(1) : path, root);
  } catch {
    throw new UsageError(
      `Cannot build a request address from "${path}" on "${base}".`,
      "Check the n8n address. `n8nctl doctor` shows the one in use."
    );
  }
  if (url.origin !== root.origin) {
    throw new UsageError(
      `Refusing to send a request to ${url.host}: requests go only to ${root.host}.`,
      "Pass a path on this n8n, such as /api/v1/workflows."
    );
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Replaying one of these cannot create or change anything. */
const IDEMPOTENT: ReadonlySet<RequestMethod> = new Set<RequestMethod>(["GET"]);

/**
 * 429 is always safe to retry: the request was rejected, so nothing was applied.
 * 5xx is safe only on an idempotent method. A 500 from a POST may have created the
 * record before it failed to answer, so replaying it could create a duplicate.
 */
export function isRetryable(status: number, method: RequestMethod): boolean {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return IDEMPOTENT.has(method);
  return false;
}

/**
 * Retry-After wins: the server is saying when it will be ready. Otherwise back off
 * exponentially with jitter, so many clients do not retry at the same moment.
 */
function retryDelayMs(response: Response, attempt: number, baseMs: number, capMs = 30_000): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const backoff = Math.min(baseMs * 2 ** (attempt - 1), capMs);
  return Math.round(backoff * (0.5 + Math.random() * 0.5));
}

export async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const ct = response.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) return await response.json();
    // A webhook can answer with plain text, and that text is its reply.
    if (ct.startsWith("text/plain")) return await response.text();
    return null;
  } catch (error) {
    // A timeout while the reply arrives must reach the caller as a timeout.
    if (error instanceof Error && error.name === "AbortError") throw error;
    return null;
  }
}

/**
 * n8n's own reason for a refusal. It is what tells a person which field was wrong,
 * so it is shown whole, with only the key removed. n8n puts it in `message`.
 */
export function extractSafeDetail(data: unknown, secret?: string): string {
  if (typeof data === "string" && data.trim() && !data.trimStart().startsWith("<")) {
    return tidy(data, secret);
  }
  if (!data || typeof data !== "object") return "no response detail";
  const obj = data as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["message", "MESSAGE", "error", "msg", "hint"]) {
    if (typeof obj[key] === "string" && obj[key]) parts.push(obj[key] as string);
  }
  if (Array.isArray(obj.errors)) {
    for (const item of obj.errors.slice(0, 3)) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item === "object") {
        const e = item as Record<string, unknown>;
        const text = [e.title, e.detail ?? e.message].filter((x) => typeof x === "string" && x).join(": ");
        if (text) parts.push(text);
      }
    }
  }
  return parts.length ? tidy(parts.join("; "), secret) : "no response detail";
}

function tidy(text: string, secret?: string): string {
  let out = text.replace(/\s+/g, " ").trim();
  if (secret) out = out.split(secret).join("****");
  return out.length > 300 ? `${out.slice(0, 297)}...` : out;
}
