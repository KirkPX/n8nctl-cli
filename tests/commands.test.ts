// The built CLI against a fake n8n (tests/fake-n8n.ts). Every command that changes a
// workflow is tested here and only here: never against a real n8n.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_EMAIL, FAKE_KEY, FAKE_PASSWORD, startFakeN8n, workflow, type FakeN8n } from "./fake-n8n.js";

const distIndex = path.resolve(import.meta.dirname ?? ".", "../dist/index.js");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A folder with a space and non-English characters, as the cross-platform rules ask. */
function folder(): string {
  const d = mkdtempSync(path.join(tmpdir(), "n8nctl flüsse 日本 "));
  dirs.push(d);
  return d;
}

type Run = { code: number | null; stdout: string; stderr: string; json: any };

let fake: FakeN8n;
const A = "aaaaaaaaaaaaaaa1";
const B = "bbbbbbbbbbbbbbb2";
const C = "ccc_ccc-ccccccc3"; // n8n IDs can hold _ and -

function n8nctl(args: string[], env: Record<string, string> = {}, input?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      env: { ...process.env, N8NCTL_BASE_URL: fake.url, N8NCTL_API_KEY: FAKE_KEY, ...env },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c) => (stdout += c));
    child.stderr!.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => {
      let json: unknown = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = null;
      }
      resolve({ code, stdout, stderr, json });
    });
    if (input !== undefined) child.stdin!.end(input);
  });
}

const writes = () => fake.requests.filter((r) => r.method !== "GET" && !r.path.startsWith("/rest/login"));

beforeEach(async () => {
  fake = await startFakeN8n([
    workflow(A, "Orders sync", { active: true, tags: [{ id: "t1", name: "finance" }] }),
    workflow(B, "Weekly report"),
    workflow(C, "Old import", { isArchived: true }),
  ]);
  fake.tags = [{ id: "t1", name: "finance" }];
  fake.executions = [
    { id: 11, workflowId: A, status: "success", mode: "webhook", startedAt: "2026-11-01T10:00:00.000Z", finished: true },
    { id: 12, workflowId: A, status: "error", mode: "trigger", startedAt: "2026-11-01T11:00:00.000Z", finished: false },
    { id: 13, workflowId: B, status: "success", mode: "manual", startedAt: "2026-11-01T12:00:00.000Z", finished: true },
  ];
});
afterEach(async () => fake.close());

describe("reading", () => {
  it("list returns every workflow as documented rows, archived ones included", async () => {
    const { code, json } = await n8nctl(["list"]);
    expect(code).toBe(0);
    expect(json.map((w: { id: string }) => w.id).sort()).toEqual([A, B, C].sort());
    expect(Object.keys(json[0]).sort()).toEqual(["active", "archived", "createdAt", "file", "id", "name", "nodeCount", "tags", "updatedAt"]);
  });

  it("list sends --active and --tag to n8n, and filters names here", async () => {
    const active = await n8nctl(["list", "--active"]);
    expect(active.json.map((w: { id: string }) => w.id)).toEqual([A]);
    expect(fake.requests.at(-1)!.query.get("active")).toBe("true");
    const tagged = await n8nctl(["list", "--tag", "finance"]);
    expect(tagged.json.map((w: { id: string }) => w.id)).toEqual([A]);
    expect(fake.requests.at(-1)!.query.get("tags")).toBe("finance");
    const named = await n8nctl(["list", "--name", "REPORT", "--exclude-archived"]);
    expect(named.json.map((w: { id: string }) => w.id)).toEqual([B]);
  });

  it("get finds a workflow by name and removes secrets", async () => {
    fake.workflows.get(B)!.nodes = [{ id: "x", name: "Code", type: "n8n-nodes-base.code", parameters: { jsCode: "const password = 'abcd1234';" } }];
    const { json } = await n8nctl(["get", "weekly report"]);
    expect(json.id).toBe(B);
    expect(JSON.stringify(json)).not.toContain("abcd1234");
  });

  it("executions passes its filters to n8n and maps failed to error", async () => {
    const { json } = await n8nctl(["executions", A, "--status", "failed", "--limit", "5"]);
    expect(json.map((e: { id: string }) => e.id)).toEqual(["12"]);
    const q = fake.requests.at(-1)!.query;
    expect([q.get("workflowId"), q.get("status"), q.get("limit")]).toEqual([A, "error", "5"]);
  });

  it("executions stops at --limit even when n8n's next page is larger", async () => {
    fake.executions = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, workflowId: A, status: "success", startedAt: "2026-11-01T00:00:00.000Z" }));
    const { json } = await n8nctl(["executions", "--limit", "300"]);
    expect(json).toHaveLength(300);
  });

  it("executions refuses a status n8n does not know, before asking n8n", async () => {
    const before = fake.requests.length;
    const { code, stderr } = await n8nctl(["executions", "--status", "broken"]);
    expect(code).toBe(1);
    expect(JSON.parse(stderr).message).toMatch(/--status takes/);
    expect(fake.requests.length).toBe(before);
  });

  it("static-data shows one saved value, and names the keys when it is missing", async () => {
    fake.workflows.get(A)!.staticData = { "node:Poller": { lastId: 7 } };
    expect((await n8nctl(["static-data", A, "--key", "node:Poller"])).json.value).toEqual({ lastId: 7 });
    const missing = await n8nctl(["static-data", A, "--key", "nope"]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stderr).hint).toContain("node:Poller");
  });

  it("credentials and nodes are read from the workflows", async () => {
    fake.workflows.get(A)!.nodes = [
      { id: "1", name: "Mail", type: "n8n-nodes-base.emailSend", credentials: { smtp: { id: "c9", name: "Mailer" } } },
    ];
    const creds = await n8nctl(["credentials"]);
    expect(creds.json).toEqual([
      { id: "c9", name: "Mailer", type: "smtp", workflows: [{ id: A, name: "Orders sync", active: true, archived: false, nodes: ["Mail"] }] },
    ]);
    const nodes = await n8nctl(["nodes"]);
    expect(nodes.json.find((n: { type: string }) => n.type === "n8n-nodes-base.webhook")).toMatchObject({ nodes: 2, workflows: 2, activeWorkflows: 0 });
  });

  it("a wrong key shows n8n's own reason and the next step", async () => {
    const { code, stderr } = await n8nctl(["list"], { N8NCTL_API_KEY: "wrong" });
    expect(code).toBe(1);
    const err = JSON.parse(stderr);
    expect(err.message).toContain("unauthorized");
    expect(err.hint).toContain("Settings > n8n API");
  });

  it("stops when n8n answers in an unknown shape", async () => {
    fake.workflows.get(B)!.active = "yes" as never;
    const { code, stderr } = await n8nctl(["list"]);
    expect(code).toBe(1);
    expect(JSON.parse(stderr).message).toMatch(/true\/false 'active'/);
  });
});

describe("backup", () => {
  it("saves every workflow, index.json and a stable JSON result", async () => {
    const dir = folder();
    const first = await n8nctl(["backup", dir, "--concurrency", "1", "--delay", "0"]);
    expect(first.code).toBe(0);
    const r = first.json;
    expect(Object.keys(r).sort()).toEqual(["complete", "completedAt", "counts", "dir", "failures", "index", "schemaVersion", "staleFiles", "startedAt", "workflows"]);
    expect(r).toMatchObject({ schemaVersion: 1, complete: true, counts: { workflows: 3, active: 1, inactive: 1, archived: 1, saved: 3, changed: 3, failed: 0 } });
    expect(Object.keys(r.workflows[0]).sort()).toEqual(["active", "archived", "changed", "contentHash", "file", "id", "name", "updatedAt"]);
    expect(readdirSync(dir).sort()).toEqual(["Old import_ccc_ccc-ccccccc3.json", "Orders sync_aaaaaaaaaaaaaaa1.json", "Weekly report_bbbbbbbbbbbbbbb2.json", "index.json"]);
    const index = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf-8"));
    expect(index.workflows[C]).toMatchObject({ archived: true, filename: "Old import_ccc_ccc-ccccccc3.json" });
    expect(writes()).toEqual([]);

    const second = await n8nctl(["backup", dir]);
    expect(second.json.counts.changed).toBe(0);
  });

  it("finds no stale file in a fresh backup", async () => {
    expect((await n8nctl(["backup", folder()])).json.staleFiles).toEqual([]);
  });

  it("lists renamed and deleted workflows' files without deleting them", async () => {
    const dir = folder();
    await n8nctl(["backup", dir]);
    fake.workflows.get(B)!.name = "Weekly report v2";
    fake.workflows.delete(C);
    const { json } = await n8nctl(["backup", dir]);
    expect(json.staleFiles.map((f: { reason: string; id: string }) => [f.reason, f.id]).sort()).toEqual([["not-on-server", C], ["renamed", B]]);
    expect(existsSync(path.join(dir, "Old import_ccc_ccc-ccccccc3.json"))).toBe(true);
  });

  it("keeps publish history in its own file", async () => {
    fake.workflows.get(A)!.activeVersion = { nodes: [], workflowPublishHistory: [{ id: 1, createdAt: "2026-10-01" }] };
    const dir = folder();
    await n8nctl(["backup", dir]);
    const history = JSON.parse(readFileSync(path.join(dir, "publish_history", `${A}.json`), "utf-8"));
    expect(history.entries).toEqual([{ createdAt: "2026-10-01", id: 1 }]);
  });
});

describe("files", () => {
  it("download, diff and list --local work in a folder with spaces and non-English characters", async () => {
    const dir = folder();
    expect((await n8nctl(["download", A, "--dir", dir])).json.saved[0].id).toBe(A);
    const same = await n8nctl(["diff", A, "--dir", dir]);
    expect(same.code).toBe(0);
    expect(same.json.hasDifferences).toBe(false);

    (fake.workflows.get(A)!.nodes as { parameters: object }[])[1]!.parameters = { value: "changed" };
    const changed = await n8nctl(["diff", "Orders", "--dir", dir]);
    expect(changed.code).toBe(1);
    expect(changed.json.counts.nodes).toBe(1);

    await n8nctl(["backup", dir]);
    const local = await n8nctl(["list", "--local", "--dir", dir, "--active"]);
    expect(local.json.map((w: { id: string }) => w.id)).toEqual([A]);
  });

  it("validate passes a sound file and fails a broken one", async () => {
    const dir = folder();
    writeFileSync(path.join(dir, "good.json"), JSON.stringify(workflow(A, "Good")));
    writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ name: "Bad", nodes: [{ name: "x", type: "t" }] }));
    const { code, json } = await n8nctl(["validate", dir]);
    expect(code).toBe(1);
    expect(json.counts).toEqual({ total: 2, passed: 1, failed: 1 });
  });
});

describe("upload", () => {
  function file(dir: string, wf: object): string {
    const f = path.join(dir, "wf.json");
    writeFileSync(f, JSON.stringify(wf));
    return f;
  }

  it("--dry-run checks and reports, and sends nothing", async () => {
    const f = file(folder(), { ...workflow(B, "Weekly report"), name: "Weekly report" });
    const { code, json } = await n8nctl(["upload", f, "--force", "--dry-run"]);
    expect(code).toBe(0);
    expect(json).toMatchObject({ dryRun: true, changed: false, results: [{ action: "would-update", id: B }] });
    expect(writes()).toEqual([]);
  });

  it("refuses to replace a workflow without --force", async () => {
    const f = file(folder(), workflow(B, "Weekly report"));
    const { code, json } = await n8nctl(["upload", f]);
    expect(code).toBe(1);
    expect(json.results[0].action).toBe("exists");
    expect(writes()).toEqual([]);
  });

  it("creates a new workflow and writes its new ID into the file", async () => {
    const wf = workflow("zzzzzzzzzzzzzzz9", "Brand new");
    delete (wf as { id?: string }).id;
    const f = file(folder(), wf);
    const { code, json } = await n8nctl(["upload", f]);
    expect(code).toBe(0);
    expect(json.results[0].action).toBe("created");
    expect(JSON.parse(readFileSync(f, "utf-8")).id).toBe(json.results[0].id);
    const sent = fake.requests.find((r) => r.method === "POST" && r.path === "/api/v1/workflows")!.body as object;
    expect(sent).not.toHaveProperty("active");
  });

  it("blocks a file with a REDACTED_ placeholder or a changed webhook", async () => {
    const wf = workflow(B, "Weekly report");
    (wf.nodes as { webhookId: string; parameters: object }[])[0]!.webhookId = "moved";
    (wf.nodes as { parameters: object }[])[1]!.parameters = { jsCode: "const password = 'REDACTED_CREDENTIAL';" };
    const { code, json } = await n8nctl(["upload", file(folder(), wf), "--force"]);
    expect(code).toBe(1);
    expect(json.results[0].action).toBe("blocked");
    expect(json.results[0].errors.join(" ")).toMatch(/webhookId/);
    expect(json.results[0].errors.join(" ")).toMatch(/REDACTED_/);
    expect(writes()).toEqual([]);
  });

  it("refuses in read-only mode", async () => {
    const f = file(folder(), workflow(B, "Weekly report"));
    const { code, stderr } = await n8nctl(["--read-only", "upload", f, "--force"]);
    expect(code).toBe(1);
    expect(JSON.parse(stderr).message).toMatch(/Read-only/);
    expect(writes()).toEqual([]);
  });
});

describe("changing state", () => {
  it("activate and deactivate report changed and unchanged", async () => {
    const on = await n8nctl(["activate", B, A]);
    expect(on.json.results.map((r: { outcome: string }) => r.outcome)).toEqual(["changed", "unchanged"]);
    expect(fake.workflows.get(B)!.active).toBe(true);
    const dry = await n8nctl(["deactivate", B, "--dry-run"]);
    expect(dry.json).toMatchObject({ dryRun: true, results: [{ outcome: "would-change" }] });
    expect(fake.workflows.get(B)!.active).toBe(true);
  });

  it("archive needs the email sign-in, then switches off and archives", async () => {
    const refused = await n8nctl(["archive", A]);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stderr).hint).toContain("login --email");
    const done = await n8nctl(["archive", A], { N8NCTL_EMAIL: FAKE_EMAIL, N8NCTL_PASSWORD: FAKE_PASSWORD });
    expect(done.code).toBe(0);
    expect(fake.workflows.get(A)).toMatchObject({ active: false, isArchived: true });
  });

  it("delete needs --yes when nobody can answer a question", async () => {
    const refused = await n8nctl(["delete", B]);
    expect(refused.code).toBe(1);
    expect(refused.json).toMatchObject({ aborted: true, hint: expect.stringContaining("--yes") });
    expect(fake.workflows.has(B)).toBe(true);
    await n8nctl(["delete", B, "--yes"]);
    expect(fake.workflows.has(B)).toBe(false);
  });

  it("tags add creates a missing tag, and remove and delete work", async () => {
    const add = await n8nctl(["tags", "add", B, "finance", "ops"]);
    expect(add.json).toMatchObject({ changed: true, added: ["finance", "ops"], createdTags: ["ops"] });
    const remove = await n8nctl(["tags", "remove", B, "OPS"]);
    expect(remove.json.after).toEqual(["finance"]);
    const del = await n8nctl(["tags", "delete", "finance", "--yes"]);
    expect(del.json.changed).toBe(true);
    expect(fake.tags.map((t) => t.name)).toEqual(["ops"]);
  });
});

describe("running", () => {
  it("trigger --dry-run shows the webhook it would call and calls nothing", async () => {
    const { json } = await n8nctl(["trigger", A, "--dry-run"]);
    expect(json).toMatchObject({ dryRun: true, method: "POST", path: `hook-${A}` });
    expect(fake.requests.some((r) => r.path.startsWith("/webhook/"))).toBe(false);
  });

  it("trigger calls the webhook with --data from a file, and sends no API key", async () => {
    const f = path.join(folder(), "body.json");
    writeFileSync(f, '﻿{"order": 5}');
    const { code, json } = await n8nctl(["trigger", A, "--data", `@${f}`]);
    expect(code).toBe(0);
    expect(json.response).toEqual({ received: { order: 5 } });
    const hook = fake.requests.find((r) => r.path.startsWith("/webhook/"))!;
    expect(hook.headers["x-n8n-api-key"]).toBeUndefined();
  });

  it("run signs in to the editor and reports the execution", async () => {
    const { code, json } = await n8nctl(["run", B], { N8NCTL_EMAIL: FAKE_EMAIL, N8NCTL_PASSWORD: FAKE_PASSWORD });
    expect(code).toBe(0);
    expect(json).toMatchObject({ changed: true, executionId: "900", trigger: "Webhook" });
  });

  it("run shows n8n's reason for a wrong password", async () => {
    const { code, stderr } = await n8nctl(["run", B], { N8NCTL_EMAIL: FAKE_EMAIL, N8NCTL_PASSWORD: "nope" });
    expect(code).toBe(1);
    expect(JSON.parse(stderr).message).toContain("Wrong username or password");
  });

  it("retry refuses a run that succeeded, and retries one that failed", async () => {
    expect((await n8nctl(["retry", "11"])).code).toBe(1);
    const { json } = await n8nctl(["retry", "12"]);
    expect(json).toMatchObject({ changed: true, executionId: "901", retryOf: "12" });
  });
});

describe("sign-in", () => {
  it("login --paste checks the key with n8n before saving it", async () => {
    const env = { N8NCTL_API_KEY: "", N8NCTL_CLI_CREDENTIAL_STORE: "file", N8NCTL_CLI_CREDENTIALS_FILE: path.join(folder(), "c.json") };
    const bad = await n8nctl(["login", "--paste"], env, "wrong-key\n");
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.stderr).message).toMatch(/refused that API key/);
    const good = await n8nctl(["login", "--paste"], env, `${FAKE_KEY}\n`);
    expect(good.json).toMatchObject({ loggedIn: true, baseUrl: fake.url });
    expect((await n8nctl(["list"], env)).code).toBe(0);
  });

  it("login --email saves the email and password after n8n accepts them", async () => {
    const config = path.join(folder(), "config.json");
    const env = { N8NCTL_CLI_CREDENTIAL_STORE: "file", N8NCTL_CLI_CREDENTIALS_FILE: path.join(folder(), "c.json"), N8NCTL_CLI_CONFIG_FILE: config };
    const { code, json, stderr } = await n8nctl(["login", "--email"], env, `${FAKE_EMAIL}\n${FAKE_PASSWORD}\n`);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(json).toMatchObject({ loggedIn: true, email: FAKE_EMAIL });
    expect(JSON.parse(readFileSync(config, "utf-8")).email).toBe(FAKE_EMAIL);
    expect(readFileSync(config, "utf-8")).not.toContain(FAKE_PASSWORD);
    expect((await n8nctl(["archive", B], env)).code).toBe(0);
  });
});
