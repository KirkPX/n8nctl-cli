// Compare a saved workflow with the live one. Nodes are matched by ID, so a renamed node
// shows as a change, not as one removed and one added.

import { sortKeys } from "./normalize.js";
import type { Workflow, WorkflowNode } from "./types.js";

/** danger: n8n links break if this changes. warn: behaviour may change. info: anything else. */
export type Severity = "danger" | "warn" | "info";

export type FieldChange = {
  path: string;
  localValue: unknown;
  serverValue: unknown;
  severity: Severity;
};

export type NodeDiff = {
  nodeId: string;
  nodeName: string | null;
  status: "added" | "removed" | "changed";
  fieldChanges: FieldChange[];
};

export type DiffResult = {
  hasDifferences: boolean;
  counts: { nodes: number; connections: number; topLevel: number; danger: number; warn: number };
  nodeDiffs: NodeDiff[];
  connectionsDiffer: boolean;
  topLevelDiffs: FieldChange[];
  dualStructureIssues: string[];
};

type RawDiff = { path: string; local: unknown; server: unknown };

function deepDiff(a: unknown, b: unknown, path: string): RawDiff[] {
  const left = a === undefined ? null : a;
  const right = b === undefined ? null : b;
  if (left === right) return [];
  if (left === null || right === null) return [{ path, local: left, server: right }];
  const leftArr = Array.isArray(left);
  if (leftArr !== Array.isArray(right) || typeof left !== typeof right) {
    return [{ path, local: left, server: right }];
  }
  if (leftArr) {
    const l = left as unknown[];
    const r = right as unknown[];
    const out: RawDiff[] = [];
    for (let i = 0; i < Math.max(l.length, r.length); i++) out.push(...deepDiff(l[i], r[i], `${path}[${i}]`));
    return out;
  }
  if (typeof left === "object") {
    const l = left as Record<string, unknown>;
    const r = right as Record<string, unknown>;
    const out: RawDiff[] = [];
    for (const key of new Set([...Object.keys(l), ...Object.keys(r)])) {
      out.push(...deepDiff(l[key], r[key], path ? `${path}.${key}` : key));
    }
    return out;
  }
  return [{ path, local: left, server: right }];
}

export function classifyFieldChange(path: string): Severity {
  if (/(?:^nodes\[\d+\]|^)\.?id$/.test(path)) return "danger";
  if (/\.webhookId$/.test(path)) return "danger";
  if (/\.credentials\.[^.]+\.id$/.test(path)) return "danger";
  if (/\.workflowId\.value$/.test(path)) return "danger";
  if (/\.type$/.test(path)) return "warn";
  if (/\.typeVersion$/.test(path)) return "warn";
  if (/\.credentials\.[^.]+\.name$/.test(path)) return "warn";
  if (/(?:^nodes\[\d+\]|^)\.?name$/.test(path)) return "warn";
  return "info";
}

function byId(nodes: WorkflowNode[] | undefined): Map<string, WorkflowNode> {
  const out = new Map<string, WorkflowNode>();
  for (const node of nodes ?? []) if (node.id) out.set(node.id, node);
  return out;
}

const TOP_LEVEL_SKIP = new Set(["nodes", "connections", "activeVersion", "_backup_metadata"]);

/** Both sides should already be in saved form (normalizeForDiff), so timestamps do not count. */
export function diffWorkflows(local: Workflow, server: Workflow): DiffResult {
  const nodeDiffs: NodeDiff[] = [];
  const localNodes = byId(local.nodes);
  const serverNodes = byId(server.nodes);
  for (const id of new Set([...localNodes.keys(), ...serverNodes.keys()])) {
    const l = localNodes.get(id);
    const s = serverNodes.get(id);
    if (!l) nodeDiffs.push({ nodeId: id, nodeName: s?.name ?? null, status: "removed", fieldChanges: [] });
    else if (!s) nodeDiffs.push({ nodeId: id, nodeName: l.name ?? null, status: "added", fieldChanges: [] });
    else {
      const changes = deepDiff(l, s, "");
      if (changes.length) {
        nodeDiffs.push({
          nodeId: id,
          nodeName: l.name ?? s.name ?? null,
          status: "changed",
          // Paths inside a node start at the node, such as `webhookId`. The rules match
          // a field after a dot, so classify `.webhookId`.
          fieldChanges: changes.map((d) => ({
            path: d.path,
            localValue: d.local,
            serverValue: d.server,
            severity: classifyFieldChange(`.${d.path}`),
          })),
        });
      }
    }
  }

  const connectionsDiffer =
    JSON.stringify(sortKeys(local.connections ?? {})) !== JSON.stringify(sortKeys(server.connections ?? {}));

  const topLevelDiffs: FieldChange[] = [];
  for (const key of new Set([...Object.keys(local), ...Object.keys(server)])) {
    if (TOP_LEVEL_SKIP.has(key)) continue;
    for (const d of deepDiff(local[key], server[key], key)) {
      topLevelDiffs.push({ path: d.path, localValue: d.local, serverValue: d.server, severity: classifyFieldChange(d.path) });
    }
  }

  const dualStructureIssues: string[] = [];
  if (local.nodes && local.activeVersion?.nodes) {
    const top = new Set(local.nodes.map((n) => n.id).filter(Boolean));
    const published = new Set(local.activeVersion.nodes.map((n) => n.id).filter(Boolean));
    for (const id of top) if (!published.has(id)) dualStructureIssues.push(`Node ${id} is in nodes but not in activeVersion.nodes`);
    for (const id of published) if (!top.has(id)) dualStructureIssues.push(`Node ${id} is in activeVersion.nodes but not in nodes`);
  }

  const all = [...nodeDiffs.flatMap((n) => n.fieldChanges), ...topLevelDiffs];
  const counts = {
    nodes: nodeDiffs.length,
    connections: connectionsDiffer ? 1 : 0,
    topLevel: topLevelDiffs.length,
    danger: all.filter((c) => c.severity === "danger").length,
    warn: all.filter((c) => c.severity === "warn").length + (connectionsDiffer ? 1 : 0),
  };
  return {
    hasDifferences: nodeDiffs.length > 0 || connectionsDiffer || topLevelDiffs.length > 0,
    counts,
    nodeDiffs,
    connectionsDiffer,
    topLevelDiffs,
    dualStructureIssues,
  };
}

function short(value: unknown): string {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > 100 ? `${text.slice(0, 100)}...` : text;
}

const TAG: Record<Severity, string> = { danger: "[DANGER]", warn: "[WARN]", info: "[INFO]" };
const MARK: Record<Severity, string> = { danger: "X", warn: "!", info: "~" };

/** The human rendering of a diff. */
export function formatDiff(result: DiffResult, header: { name: string; id: string; localFile: string }): string {
  const lines: string[] = [];
  const sep = "=".repeat(60);
  lines.push(sep, `DIFF: ${header.name} (ID: ${header.id})`, `Local:  ${header.localFile}`, "Server: live", sep);

  if (result.nodeDiffs.length) {
    lines.push(`\nNODES (${result.nodeDiffs.length} changed):`);
    for (const nd of result.nodeDiffs) {
      if (nd.status === "added") lines.push(`  + ${nd.nodeName} (id: ${nd.nodeId})  [in the local file, not on the server]`);
      else if (nd.status === "removed") lines.push(`  - ${nd.nodeName} (id: ${nd.nodeId})  [on the server, not in the local file]`);
      else {
        lines.push(`  ~ ${nd.nodeName} (id: ${nd.nodeId})`);
        for (const fc of nd.fieldChanges) {
          lines.push(`      ${MARK[fc.severity]} ${fc.path}  ${TAG[fc.severity]}`);
          lines.push(`        local:  ${short(fc.localValue)}`, `        server: ${short(fc.serverValue)}`);
        }
      }
    }
  } else lines.push("\nNODES: no changes");

  lines.push(result.connectionsDiffer ? "\nCONNECTIONS: the links between nodes differ  [WARN]" : "\nCONNECTIONS: no changes");

  if (result.topLevelDiffs.length) {
    lines.push("\nTOP-LEVEL FIELDS:");
    for (const td of result.topLevelDiffs) {
      lines.push(`  ${MARK[td.severity]} ${td.path}  ${TAG[td.severity]}`);
      lines.push(`    local:  ${short(td.localValue)}`, `    server: ${short(td.serverValue)}`);
    }
  }

  if (result.dualStructureIssues.length) {
    lines.push("\nPUBLISHED COPY:");
    for (const issue of result.dualStructureIssues) lines.push(`  ! ${issue}`);
  }

  const total = result.counts.nodes + result.counts.connections + result.counts.topLevel;
  lines.push(`\n${sep}`);
  if (!total) lines.push("RESULT: no differences");
  else {
    let summary = `RESULT: ${total} difference${total === 1 ? "" : "s"}`;
    if (result.counts.danger) summary += `  (${result.counts.danger} DANGER: check before uploading)`;
    else if (result.counts.warn) summary += `  (${result.counts.warn} WARN)`;
    lines.push(summary);
  }
  return lines.join("\n");
}
