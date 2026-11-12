// A fake n8n for tests. It answers the public API, the editor sign-in and webhooks
// on 127.0.0.1, records every request, and never reaches a real server.
// Tests that change workflows use this, never a real n8n.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Recorded = { method: string; path: string; query: URLSearchParams; headers: IncomingMessage["headers"]; body: unknown };

export type FakeWorkflow = Record<string, unknown> & { id: string; name: string; active: boolean };

export type FakeN8n = {
  url: string;
  key: string;
  requests: Recorded[];
  workflows: Map<string, FakeWorkflow>;
  tags: { id: string; name: string }[];
  executions: Record<string, unknown>[];
  close(): Promise<void>;
};

export const FAKE_KEY = "fake-n8n-key-1234567890";
export const FAKE_EMAIL = "tester@example.com";
export const FAKE_PASSWORD = "correct horse";

export function workflow(id: string, name: string, extra: Record<string, unknown> = {}): FakeWorkflow {
  return {
    id,
    name,
    active: false,
    isArchived: false,
    nodes: [
      { id: `${id}-n1`, name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, webhookId: `${id}-hook`, parameters: { path: `hook-${id}`, httpMethod: "POST" } },
      { id: `${id}-n2`, name: "Set", type: "n8n-nodes-base.set", typeVersion: 3, parameters: { value: "x" } },
    ],
    connections: { Webhook: { main: [[{ node: "Set", type: "main", index: 0 }]] } },
    settings: { executionOrder: "v1" },
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    versionId: "v-1",
    triggerCount: 1,
    staticData: null,
    ...extra,
  };
}

export async function startFakeN8n(seed: FakeWorkflow[] = []): Promise<FakeN8n> {
  const state = {
    requests: [] as Recorded[],
    workflows: new Map(seed.map((w) => [w.id, structuredClone(w)])),
    tags: [] as { id: string; name: string }[],
    executions: [] as Record<string, unknown>[],
  };
  let nextId = 1;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: unknown = undefined;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    state.requests.push({ method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body });
    const send = (status: number, data?: unknown, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(data === undefined ? "" : JSON.stringify(data));
    };
    const p = url.pathname;

    if (p.startsWith("/webhook/")) return send(200, { received: body ?? null });
    if (p === "/rest/login" && req.method === "POST") {
      const b = body as Record<string, string>;
      if (b?.emailOrLdapLoginId === FAKE_EMAIL && b?.password === FAKE_PASSWORD) {
        return send(200, { data: { email: FAKE_EMAIL } }, { "set-cookie": ["n8n-auth=session-cookie; Path=/; HttpOnly"] });
      }
      return send(401, { code: 401, message: "Wrong username or password. Do you have caps lock on?" });
    }
    if (p.startsWith("/rest/")) {
      if (!String(req.headers.cookie ?? "").includes("n8n-auth=session-cookie")) return send(401, { message: "Unauthorized" });
      const m = /^\/rest\/workflows\/([^/]+)\/(archive|unarchive|run)$/.exec(p);
      const wf = m ? state.workflows.get(m[1]!) : undefined;
      if (m && wf) {
        if (m[2] === "archive") wf.isArchived = true;
        if (m[2] === "unarchive") wf.isArchived = false;
        if (m[2] === "run") return send(200, { data: { executionId: "900" } });
        return send(200, { data: wf });
      }
      return send(404, { message: "Not Found" });
    }
    if (!p.startsWith("/api/v1/")) return send(404, { message: "not found" });
    if (req.headers["x-n8n-api-key"] !== FAKE_KEY) return send(401, { message: "unauthorized" });

    const known = new Set(["limit", "cursor", "active", "tags", "name", "workflowId", "status", "includeData", "projectId"]);
    for (const key of url.searchParams.keys()) {
      if (!known.has(key)) return send(400, { message: `Unknown query parameter '${key}'` });
    }

    if (p === "/api/v1/workflows" && req.method === "GET") {
      let list = [...state.workflows.values()];
      const active = url.searchParams.get("active");
      if (active !== null) list = list.filter((w) => String(w.active) === active);
      const tags = url.searchParams.get("tags");
      if (tags) list = list.filter((w) => tags.split(",").every((t) => (w.tags as { name: string }[]).some((x) => x.name === t)));
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const page = list.slice(start, start + limit);
      return send(200, { data: page, nextCursor: start + limit < list.length ? String(start + limit) : null });
    }
    if (p === "/api/v1/workflows" && req.method === "POST") {
      const id = `new${String(nextId++).padStart(13, "0")}`;
      const wf = { ...(body as object), id, active: false, isArchived: false, tags: [] } as unknown as FakeWorkflow;
      state.workflows.set(id, wf);
      return send(200, wf);
    }
    let m = /^\/api\/v1\/workflows\/([^/]+)(?:\/(activate|deactivate|tags))?$/.exec(p);
    if (m) {
      const wf = state.workflows.get(decodeURIComponent(m[1]!));
      if (!wf) return send(404, { message: "Not Found" });
      if (m[2] === "activate") { wf.active = true; return send(200, wf); }
      if (m[2] === "deactivate") { wf.active = false; return send(200, wf); }
      if (m[2] === "tags" && req.method === "PUT") {
        wf.tags = (body as { id: string }[]).map((t) => state.tags.find((x) => x.id === t.id)!);
        return send(200, wf.tags);
      }
      if (req.method === "GET") return send(200, wf);
      if (req.method === "PUT") {
        const next = { ...wf, ...(body as object), id: wf.id, updatedAt: "2026-03-01T00:00:00.000Z" } as FakeWorkflow;
        state.workflows.set(wf.id, next);
        return send(200, next);
      }
      if (req.method === "DELETE") { state.workflows.delete(wf.id); return send(200, wf); }
    }
    if (p === "/api/v1/tags" && req.method === "GET") return send(200, { data: state.tags, nextCursor: null });
    if (p === "/api/v1/tags" && req.method === "POST") {
      const tag = { id: `t${state.tags.length + 1}`, name: (body as { name: string }).name };
      state.tags.push(tag);
      return send(201, tag);
    }
    m = /^\/api\/v1\/tags\/([^/]+)$/.exec(p);
    if (m && req.method === "DELETE") {
      state.tags = state.tags.filter((t) => t.id !== m![1]);
      return send(200, {});
    }
    if (p === "/api/v1/executions") {
      let list = state.executions;
      const wid = url.searchParams.get("workflowId");
      const status = url.searchParams.get("status");
      if (status && !["canceled", "error", "running", "success", "waiting"].includes(status)) {
        return send(400, { message: "request/query/status must be equal to one of the allowed values" });
      }
      if (wid) list = list.filter((e) => e.workflowId === wid);
      if (status) list = list.filter((e) => e.status === status);
      // Like n8n, the cursor holds the first page's size, and a later `limit` is ignored.
      const cursor = url.searchParams.get("cursor");
      const [start, size] = cursor ? cursor.split(":").map(Number) : [0, Number(url.searchParams.get("limit") ?? 100)];
      const next = start! + size! < list.length ? `${start! + size!}:${size}` : null;
      return send(200, { data: list.slice(start, start! + size!), nextCursor: next });
    }
    m = /^\/api\/v1\/executions\/([^/]+)(\/retry)?$/.exec(p);
    if (m) {
      const ex = state.executions.find((e) => String(e.id) === m![1]);
      if (!ex) return send(404, { message: "Not Found" });
      if (m[2]) return send(200, { ...ex, id: 901, status: "running", retryOf: ex.id });
      return send(200, ex);
    }
    return send(404, { message: "Not Found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    key: FAKE_KEY,
    get requests() { return state.requests; },
    get workflows() { return state.workflows; },
    get tags() { return state.tags; },
    set tags(v) { state.tags = v; },
    get executions() { return state.executions; },
    set executions(v) { state.executions = v; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  } as FakeN8n;
}
