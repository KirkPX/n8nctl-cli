// `n8nctl nodes`: which node types the workflows use, and how often.

import type { Workflow } from "../../workflow/types.js";
import { createClient, type ClientOpts } from "../client-helpers.js";
import { reporter } from "../output.js";
import { fromBackup } from "./credentials.js";

export type NodeUse = { type: string; nodes: number; workflows: number; activeWorkflows: number };

export async function nodesCommand(opts: ClientOpts & { local?: boolean; dir?: string } = {}): Promise<void> {
  const r = reporter(opts);
  const workflows = opts.local ? await fromBackup(opts) : await createClient(opts).listWorkflows();
  const rows = nodeUses(workflows);
  const pretty = rows.length
    ? [`${"Nodes".padStart(6)}  ${"Workflows".padStart(9)}  Type`, ...rows.map((n) => `${String(n.nodes).padStart(6)}  ${String(n.workflows).padStart(9)}  ${n.type}`)].join("\n")
    : "No nodes found.";
  r.result(rows, pretty);
}

export function nodeUses(workflows: Workflow[]): NodeUse[] {
  const map = new Map<string, { nodes: number; wfs: Set<string>; on: Set<string> }>();
  for (const wf of workflows) {
    for (const node of wf.nodes ?? []) {
      const type = node.type ?? "(no type)";
      const m = map.get(type) ?? { nodes: 0, wfs: new Set(), on: new Set() };
      m.nodes++;
      m.wfs.add(wf.id!);
      if (wf.active && !wf.isArchived) m.on.add(wf.id!);
      map.set(type, m);
    }
  }
  return [...map.entries()]
    .map(([type, m]) => ({ type, nodes: m.nodes, workflows: m.wfs.size, activeWorkflows: m.on.size }))
    .sort((a, b) => b.nodes - a.nodes || a.type.localeCompare(b.type));
}
