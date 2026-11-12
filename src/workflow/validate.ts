// Checks a workflow file must pass before it is uploaded. They catch mistakes n8n would
// accept and then break on: missing node IDs, links to nodes that do not exist, and
// changed IDs that other workflows, webhooks or credentials point at.

import { findRedactedMarkers } from "./sanitize.js";
import type { Workflow, WorkflowNode } from "./types.js";

export type CheckResult = { valid: boolean; errors: string[]; warnings: string[] };

function connectionTargets(outputs: unknown): string[] {
  const out: string[] = [];
  if (!outputs || typeof outputs !== "object") return out;
  for (const branches of Object.values(outputs)) {
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (!Array.isArray(branch)) continue;
      for (const conn of branch) {
        if (conn && typeof conn === "object" && typeof (conn as { node?: unknown }).node === "string") {
          out.push((conn as { node: string }).node);
        }
      }
    }
  }
  return out;
}

/**
 * Checks that need only the file. Errors stop an upload; warnings do not.
 */
export function checkWorkflow(data: unknown): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { valid: false, errors: ["The file must hold one JSON object, the workflow."], warnings };
  }
  const wf = data as Workflow;
  if (typeof wf.name !== "string" || !wf.name) errors.push("The workflow has no 'name'.");
  if (!Array.isArray(wf.nodes)) {
    errors.push("The workflow has no 'nodes' list.");
    return { valid: false, errors, warnings };
  }
  if (wf.connections !== undefined && (typeof wf.connections !== "object" || Array.isArray(wf.connections))) {
    errors.push("'connections' must be an object.");
  }

  const seen = new Map<string, string>();
  wf.nodes.forEach((node: WorkflowNode, i) => {
    if (!node || typeof node !== "object") {
      errors.push(`Node ${i} is not an object.`);
      return;
    }
    const label = node.name || "unnamed";
    if (!node.id) errors.push(`Node ${i} ('${label}') has no 'id'.`);
    else if (seen.has(node.id)) errors.push(`Two nodes share the ID ${node.id}: '${seen.get(node.id)}' and '${label}'.`);
    else seen.set(node.id, label);
    if (!node.type) errors.push(`Node ${i} ('${label}') has no 'type'.`);
  });

  if (wf.activeVersion?.nodes) {
    const top = new Set(wf.nodes.map((n) => n.id).filter(Boolean));
    const published = new Set(wf.activeVersion.nodes.map((n) => n.id).filter(Boolean));
    for (const id of top) if (!published.has(id)) errors.push(`Node ${id} is in nodes but not in activeVersion.nodes. Make the two lists match.`);
    for (const id of published) if (!top.has(id)) errors.push(`Node ${id} is in activeVersion.nodes but not in nodes. Make the two lists match.`);
  }

  const names = new Set(wf.nodes.map((n) => n?.name).filter((n): n is string => Boolean(n)));
  for (const [source, outputs] of Object.entries(wf.connections ?? {})) {
    if (!names.has(source)) errors.push(`A connection starts at '${source}', but no node has that name.`);
    for (const target of connectionTargets(outputs)) {
      if (!names.has(target)) errors.push(`A connection from '${source}' goes to '${target}', but no node has that name.`);
    }
  }

  const markers = findRedactedMarkers(wf.nodes, "nodes");
  for (const where of markers.slice(0, 5)) {
    errors.push(`${where} holds a REDACTED_ placeholder. Put the real value back before you upload, or the live workflow loses it.`);
  }
  if (markers.length > 5) errors.push(`${markers.length - 5} more places hold REDACTED_ placeholders.`);

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Compare the file with the live workflow it would replace. n8n links webhooks,
 * credentials and sub-workflow calls by ID, so a changed ID breaks them.
 */
export function checkAgainstServer(local: Workflow, server: Workflow): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const serverByName = new Map<string, WorkflowNode>();
  for (const n of server.nodes ?? []) if (n.name) serverByName.set(n.name, n);

  for (const node of local.nodes ?? []) {
    const live = node.name ? serverByName.get(node.name) : undefined;
    if (!live) continue;
    if (node.id && live.id && node.id !== live.id) {
      errors.push(`Node '${node.name}' has a new ID: the server has ${live.id}, the file has ${node.id}.`);
    }
    if (live.webhookId && node.webhookId !== live.webhookId) {
      errors.push(`Node '${node.name}' has a new webhookId: the server has ${live.webhookId}, the file has ${node.webhookId ?? "none"}. Its web address would change.`);
    }
    for (const [type, liveCred] of Object.entries(live.credentials ?? {})) {
      const fileCred = node.credentials?.[type];
      if (liveCred?.id && fileCred?.id && fileCred.id !== liveCred.id) {
        errors.push(`Node '${node.name}' points at a different '${type}' credential: the server has ${liveCred.id}, the file has ${fileCred.id}.`);
      }
      if (liveCred?.id && fileCred?.id === liveCred.id && fileCred.name && fileCred.name !== liveCred.name) {
        warnings.push(`Node '${node.name}': credential '${type}' is renamed from '${liveCred.name}' to '${fileCred.name}'. The ID is the same, so this is safe.`);
      }
    }
    if (node.type === "n8n-nodes-base.executeWorkflow") {
      const fileRef = (node.parameters?.workflowId as { value?: string } | undefined)?.value;
      const liveRef = (live.parameters?.workflowId as { value?: string } | undefined)?.value;
      if (fileRef && liveRef && fileRef !== liveRef) {
        warnings.push(`Node '${node.name}' now calls sub-workflow ${fileRef} instead of ${liveRef}.`);
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

/** Fields n8n sends with a workflow but refuses on create or update. */
const SYSTEM_FIELDS = [
  "id",
  "createdAt",
  "updatedAt",
  "description",
  "isArchived",
  "versionId",
  "versionCounter",
  "activeVersionId",
  "triggerCount",
  "staticData",
  "meta",
  "pinData",
  "active",
  "tags",
  "activeVersion",
  "shared",
  "_backup_metadata",
];
/** Settings newer n8n versions return but refuse on update. */
const READ_ONLY_SETTINGS = ["availableInMCP", "timeSavedMode", "binaryMode"];

/** The body n8n accepts for create and update. The input is not changed. */
export function uploadBody(workflow: Workflow): Record<string, unknown> {
  const body: Record<string, unknown> = { ...workflow };
  for (const field of SYSTEM_FIELDS) delete body[field];
  if (workflow.settings && typeof workflow.settings === "object") {
    const settings = { ...workflow.settings };
    for (const field of READ_ONLY_SETTINGS) delete settings[field];
    body.settings = settings;
  }
  return body;
}
