// How `trigger` and `run` start a workflow. Both are worked out from the workflow alone,
// before anything is sent, so --dry-run shows exactly what a real run would do.

import type { Workflow, WorkflowNode } from "./types.js";

export type Plan<T> = ({ ok: true } & T) | { ok: false; error: string };

function label(wf: Workflow): string {
  return `'${wf.name}' (${wf.id})`;
}

/**
 * `trigger` calls the workflow's own Webhook node, the way an outside system does. The
 * public API has no endpoint that runs a workflow.
 */
export function planWebhookTrigger(
  wf: Workflow,
  opts: { nodeName?: string } = {}
): Plan<{ node: string; method: string; path: string }> {
  if (wf.isArchived) return { ok: false, error: `Workflow ${label(wf)} is archived.` };
  const hooks = (wf.nodes ?? []).filter((n) => n.type === "n8n-nodes-base.webhook" && !n.disabled);
  if (!hooks.length) {
    return {
      ok: false,
      error: `Workflow ${label(wf)} has no Webhook trigger, so it cannot be called from outside. Use \`n8nctl run ${wf.id}\` instead.`,
    };
  }
  const names = hooks.map((n) => `'${n.name}'`).join(", ");
  let node: WorkflowNode | undefined = hooks[0];
  if (opts.nodeName) {
    node = hooks.find((n) => n.name === opts.nodeName);
    if (!node) return { ok: false, error: `Workflow ${label(wf)} has no enabled Webhook node named '${opts.nodeName}'. Its Webhook nodes: ${names}.` };
  } else if (hooks.length > 1) {
    return { ok: false, error: `Workflow ${label(wf)} has ${hooks.length} Webhook nodes. Pick one with --node: ${names}.` };
  }
  const params = node!.parameters ?? {};
  const auth = params.authentication;
  if (auth && auth !== "none") {
    return { ok: false, error: `Webhook '${node!.name}' needs ${String(auth)} credentials, which this CLI does not hold. Use \`n8nctl run ${wf.id}\` instead.` };
  }
  const path = String(params.path || node!.webhookId || "").replace(/^\/+/, "");
  if (!path) return { ok: false, error: `Webhook '${node!.name}' has no path.` };
  if (path.includes(":")) return { ok: false, error: `Webhook '${node!.name}' has a path parameter ('${path}'), which this CLI cannot fill in.` };
  if (!wf.active) {
    return { ok: false, error: `Workflow ${label(wf)} is off, and its webhook answers only while it is on. Run \`n8nctl activate ${wf.id}\` first.` };
  }
  // The Webhook node defaults to GET. With "allow multiple methods", httpMethod is a list.
  const methods = ([] as unknown[]).concat(params.httpMethod ?? "GET").map((m) => String(m).toUpperCase());
  const method = methods.includes("POST") ? "POST" : methods[0]!;
  return { ok: true, node: node!.name ?? "", method, path };
}

const OLD_TRIGGER_TYPES = new Set([
  "n8n-nodes-base.webhook",
  "n8n-nodes-base.start",
  "n8n-nodes-base.cron",
  "n8n-nodes-base.interval",
]);

function isTrigger(n: WorkflowNode): boolean {
  return !n.disabled && (/trigger$/i.test(n.type ?? "") || OLD_TRIGGER_TYPES.has(n.type ?? ""));
}

export type ManualRun = {
  trigger: string;
  version: "published" | "draft";
  pinned: string[];
  payload: Record<string, unknown>;
};

/**
 * The request body the editor's "Execute workflow" button sends. It runs the published
 * version when there is one, because that is what production runs. `data` becomes the
 * trigger's output: one object is one item, a list is one item each.
 */
export function buildManualRun(
  wf: Workflow,
  opts: { triggerName?: string; data?: unknown } = {}
): Plan<ManualRun> {
  if (wf.isArchived) return { ok: false, error: `Workflow ${label(wf)} is archived.` };
  const published = wf.activeVersion?.nodes ? wf.activeVersion : null;
  const nodes = (published ?? wf).nodes ?? [];
  const connections = (published ?? wf).connections ?? {};
  const triggers = nodes.filter(isTrigger);
  if (!triggers.length) return { ok: false, error: `Workflow ${label(wf)} has no trigger node to start from.` };
  const names = triggers.map((n) => `'${n.name}'`).join(", ");
  let trigger: WorkflowNode | undefined = triggers[0];
  if (opts.triggerName) {
    trigger = triggers.find((n) => n.name === opts.triggerName);
    if (!trigger) return { ok: false, error: `Workflow ${label(wf)} has no enabled trigger named '${opts.triggerName}'. Its triggers: ${names}.` };
  } else if (triggers.length > 1) {
    return { ok: false, error: `Workflow ${label(wf)} has ${triggers.length} triggers. Pick one with --trigger: ${names}.` };
  }
  const triggerName = trigger!.name ?? "";
  const pinData: Record<string, unknown> = { ...(wf.pinData ?? {}) };
  if (opts.data !== undefined) {
    pinData[triggerName] = ([] as unknown[]).concat(opts.data).map((item) => ({ json: item }));
  }
  return {
    ok: true,
    trigger: triggerName,
    version: published ? "published" : "draft",
    pinned: Object.keys(pinData),
    payload: {
      workflowData: {
        id: wf.id,
        name: wf.name,
        nodes,
        connections,
        settings: wf.settings ?? {},
        active: wf.active,
        pinData,
        staticData: wf.staticData,
      },
      triggerToStartFrom: { name: triggerName },
    },
  };
}
