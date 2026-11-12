import { describe, expect, it } from "vitest";
import { diffWorkflows, formatDiff } from "../src/workflow/diff.js";
import { contentHash, normalizeForDiff, savedForm, savedText, sanitizeFilename, workflowFilename } from "../src/workflow/normalize.js";
import { buildManualRun, planWebhookTrigger } from "../src/workflow/plan.js";
import { findRedactedMarkers, sanitizeWorkflow } from "../src/workflow/sanitize.js";
import type { Workflow } from "../src/workflow/types.js";
import { checkAgainstServer, checkWorkflow, uploadBody } from "../src/workflow/validate.js";
import { workflow } from "./fake-n8n.js";

// Synthetic values only.
const code = (js: string): Workflow => ({ nodes: [{ name: "C", type: "n8n-nodes-base.code", parameters: { jsCode: js } }] });
const clean = (js: string) => (sanitizeWorkflow(code(js)).nodes![0]!.parameters as { jsCode: string }).jsCode;

describe("secret removal", () => {
  it.each([
    ["const creds = {\n  user: 'ALICE',\n  pwd:  'hunter2pw',\n};", "const creds = {\n  user: 'ALICE',\n  pwd:  'REDACTED_CREDENTIAL',\n};"],
    ['const password = "abcd1234";', 'const password = "REDACTED_CREDENTIAL";'],
    ['const c = { "passwd": "s3cret!" };', 'const c = { "passwd": "REDACTED_CREDENTIAL" };'],
    ["const PWD = `Tr0ub4dor&3`;", "const PWD = `REDACTED_CREDENTIAL`;"],
    ["x = { pwd: 'it\\'s-a-pw' };", "x = { pwd: 'REDACTED_CREDENTIAL' };"],
    ["const apiKey = '00000000-1111-2222-3333-444444444444';", "const apiKey = 'REDACTED_API_KEY';"],
    ['const c = { "api_key": "abcdef123456abcdef" };', 'const c = { "api_key": "REDACTED_API_KEY" };'],
    ["Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345'", "Authorization: 'Bearer REDACTED_TOKEN'"],
    ["slack xoxb-1234-abcd", "slack REDACTED_SLACK_TOKEN"],
  ])("removes %j", (input, output) => {
    expect(clean(input)).toBe(output);
  });

  it.each([
    "<password>${v.pf_pwd}</password>",
    "const pwd = `${$env.PF_PWD}`;",
    "const pwd = v.pf_pwd;",
    "const c = { pwd: 'REDACTED_CREDENTIAL' };",
    "const c = { password: '' };",
    "const passwordHint = 'see vault';",
    "headers: { Authorization: apiKey }",
    "const token = 'short';",
    "const secret = 'see the vault entry';",
  ])("leaves %j alone", (input) => {
    expect(clean(input)).toBe(input);
  });

  it("removes a random value under a secret-sounding key, but not an expression", () => {
    const wf: Workflow = {
      nodes: [{ name: "H", type: "x", parameters: { token: "aZ9$kQ2!mW7#pL4@xR8^", other: "={{ $json.token }}" } }],
    };
    const out = sanitizeWorkflow(wf).nodes![0]!.parameters!;
    expect(out.token).toBe("REDACTED_CREDENTIAL");
    expect(out.other).toBe("={{ $json.token }}");
  });

  it("does not change its input", () => {
    const wf = code("const password = 'abcd1234';");
    sanitizeWorkflow(wf);
    expect((wf.nodes![0]!.parameters as { jsCode: string }).jsCode).toContain("abcd1234");
  });

  it("finds the markers it leaves, with their place", () => {
    expect(findRedactedMarkers(sanitizeWorkflow(code("const password = 'abcd1234';")).nodes, "nodes")).toEqual(["nodes[0].parameters.jsCode"]);
  });
});

describe("saved form", () => {
  const wf = workflow("abcDEF1234567890", "Orders / Daily: <sync>") as Workflow;

  it("drops what changes without an edit, and keeps the server date in metadata", () => {
    const saved = savedForm(wf);
    for (const field of ["versionId", "triggerCount", "staticData", "updatedAt"]) expect(saved).not.toHaveProperty(field);
    expect(saved._backup_metadata).toMatchObject({ workflow_id: wf.id, server_updated_at: wf.updatedAt });
    expect(saved._backup_metadata!.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is byte-identical for an unchanged workflow, whatever n8n's counters say", () => {
    const later = { ...wf, versionId: "v-2", triggerCount: 9, updatedAt: wf.updatedAt };
    expect(savedText(later)).toBe(savedText(wf));
    expect(contentHash({ ...wf, updatedAt: "2030-01-01" })).toBe(contentHash(wf));
  });

  it("changes the hash when a node changes", () => {
    const edited = structuredClone(wf);
    (edited.nodes as { parameters: Record<string, unknown> }[])[1]!.parameters.value = "y";
    expect(contentHash(edited)).not.toBe(contentHash(wf));
  });

  it("writes keys in order, two-space indented, with no trailing newline", () => {
    const text = savedText(wf);
    expect(text.endsWith("}")).toBe(true);
    const keys = Object.keys(JSON.parse(text));
    expect(keys).toEqual([...keys].sort());
  });

  it("names files the way existing backups do", () => {
    expect(workflowFilename(wf)).toBe("Orders _ Daily_ _sync__abcDEF1234567890.json");
    expect(sanitizeFilename("a".repeat(300))).toHaveLength(200);
  });
});

describe("diff", () => {
  const base = normalizeForDiff(workflow("abcDEF1234567890", "W"));

  it("finds no difference between equal workflows", () => {
    expect(diffWorkflows(base, structuredClone(base)).hasDifferences).toBe(false);
  });

  it("marks a changed webhook ID as danger and a changed parameter as info", () => {
    const server = structuredClone(base);
    const nodes = server.nodes!;
    nodes[0]!.webhookId = "other";
    nodes[1]!.parameters = { value: "changed" };
    const result = diffWorkflows(base, server);
    expect(result.counts.danger).toBe(1);
    expect(result.nodeDiffs.flatMap((n) => n.fieldChanges.map((c) => [c.path, c.severity]))).toEqual(
      expect.arrayContaining([["webhookId", "danger"], ["parameters.value", "info"]])
    );
    expect(formatDiff(result, { name: "W", id: "x", localFile: "f" })).toContain("DANGER");
  });

  it("reports added and removed nodes, and changed links", () => {
    const server = structuredClone(base);
    server.nodes = server.nodes!.slice(0, 1);
    server.connections = {};
    const result = diffWorkflows(base, server);
    expect(result.nodeDiffs).toEqual([expect.objectContaining({ status: "added", nodeName: "Set" })]);
    expect(result.connectionsDiffer).toBe(true);
  });
});

describe("upload checks", () => {
  const wf = workflow("abcDEF1234567890", "W") as Workflow;

  it("passes a sound workflow", () => {
    expect(checkWorkflow(wf)).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it("refuses a missing ID, a duplicate ID and a link to no node", () => {
    const bad = structuredClone(wf);
    bad.nodes = [{ name: "A", type: "t" }, { id: "1", name: "B", type: "t" }, { id: "1", name: "C", type: "t" }];
    bad.connections = { A: { main: [[{ node: "Gone", type: "main", index: 0 }]] } };
    const { errors } = checkWorkflow(bad);
    expect(errors.join("\n")).toMatch(/has no 'id'/);
    expect(errors.join("\n")).toMatch(/share the ID 1/);
    expect(errors.join("\n")).toMatch(/goes to 'Gone'/);
  });

  it("refuses a file that still holds a REDACTED_ placeholder", () => {
    const { valid, errors } = checkWorkflow(sanitizeWorkflow(code("const password = 'abcd1234';")) as Workflow & { name: string });
    expect(valid).toBe(false);
    expect(errors.join(" ")).toMatch(/REDACTED_ placeholder/);
  });

  it("refuses changed node, webhook and credential IDs against the server", () => {
    const server = structuredClone(wf);
    server.nodes![0]!.credentials = { httpBasicAuth: { id: "c1", name: "Old" } };
    const local = structuredClone(server);
    local.nodes![0]!.webhookId = "new-hook";
    local.nodes![0]!.credentials = { httpBasicAuth: { id: "c2", name: "Old" } };
    local.nodes![1]!.id = "different";
    const { errors } = checkAgainstServer(local, server);
    expect(errors).toHaveLength(3);
  });

  it("sends only the fields n8n accepts", () => {
    const body = uploadBody({ ...wf, settings: { executionOrder: "v1", binaryMode: "x" } });
    for (const field of ["id", "active", "tags", "versionId", "staticData", "updatedAt"]) expect(body).not.toHaveProperty(field);
    expect(body.settings).toEqual({ executionOrder: "v1" });
  });
});

describe("run plans", () => {
  const wf = workflow("abcDEF1234567890", "W", { active: true }) as Workflow;

  it("plans a webhook call from the Webhook node", () => {
    expect(planWebhookTrigger(wf)).toEqual({ ok: true, node: "Webhook", method: "POST", path: "hook-abcDEF1234567890" });
  });

  it("refuses a workflow that is off, and one with a path parameter", () => {
    expect(planWebhookTrigger({ ...wf, active: false })).toMatchObject({ ok: false, error: expect.stringContaining("is off") });
    const param = structuredClone(wf);
    param.nodes![0]!.parameters = { path: "orders/:id" };
    expect(planWebhookTrigger(param)).toMatchObject({ ok: false, error: expect.stringContaining("path parameter") });
  });

  it("builds the editor's run request, with --data as the trigger's output", () => {
    const plan = buildManualRun(wf, { data: [{ a: 1 }, { a: 2 }] });
    expect(plan).toMatchObject({ ok: true, trigger: "Webhook", version: "draft" });
    if (plan.ok) {
      expect((plan.payload.workflowData as { pinData: Record<string, unknown> }).pinData.Webhook).toEqual([{ json: { a: 1 } }, { json: { a: 2 } }]);
      expect(plan.payload.triggerToStartFrom).toEqual({ name: "Webhook" });
    }
  });
});
