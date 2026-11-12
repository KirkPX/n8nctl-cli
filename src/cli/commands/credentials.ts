// `n8nctl credentials`: the credentials workflows use, and which workflows use each.
//
// n8n's public API does not list credentials (GET /credentials answers 405), so the
// list is read from the workflows: every node names the credential it uses by ID,
// name and type. Secrets are never in a workflow, so none can appear here.

import path from "node:path";
import { resolveConfig } from "../../config.js";
import { loadWorkflowFile, readIndex } from "../../workflow/files.js";
import type { Workflow } from "../../workflow/types.js";
import { createClient, type ClientOpts } from "../client-helpers.js";
import { reporter } from "../output.js";

export type CredentialUse = {
  id: string | null;
  name: string | null;
  type: string;
  workflows: { id: string; name: string; active: boolean; archived: boolean; nodes: string[] }[];
};

export async function credentialsCommand(opts: ClientOpts & { local?: boolean; dir?: string } = {}): Promise<void> {
  const r = reporter(opts);
  const workflows = opts.local ? await fromBackup(opts) : await createClient(opts).listWorkflows();
  const rows = credentialUses(workflows);
  const pretty = rows.length
    ? rows
        .map((c) => {
          const on = c.workflows.filter((w) => w.active && !w.archived).length;
          return `${c.name ?? "(no name)"}  [${c.type}]  ${c.id ?? ""}\n  used by ${c.workflows.length} workflow(s), ${on} on`;
        })
        .join("\n")
    : "No workflow uses a credential.";
  r.result(rows, pretty);
}

/** Group every node's credential reference by credential. */
export function credentialUses(workflows: Workflow[]): CredentialUse[] {
  const map = new Map<string, CredentialUse>();
  for (const wf of workflows) {
    for (const node of wf.nodes ?? []) {
      for (const [type, ref] of Object.entries(node.credentials ?? {})) {
        if (!ref) continue;
        const key = ref.id ?? `${type}:${ref.name}`;
        let use = map.get(key);
        if (!use) {
          use = { id: ref.id ?? null, name: ref.name ?? null, type, workflows: [] };
          map.set(key, use);
        }
        let entry = use.workflows.find((w) => w.id === wf.id);
        if (!entry) {
          entry = { id: wf.id!, name: wf.name ?? "", active: Boolean(wf.active), archived: Boolean(wf.isArchived), nodes: [] };
          use.workflows.push(entry);
        }
        if (node.name && !entry.nodes.includes(node.name)) entry.nodes.push(node.name);
      }
    }
  }
  return [...map.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.type.localeCompare(b.type));
}

/** Workflows as a backup folder holds them; index.json says which files are current. */
export async function fromBackup(opts: ClientOpts & { dir?: string }): Promise<Workflow[]> {
  const dir = opts.dir ?? resolveConfig({ account: opts.account }).workflowsDir;
  const index = await readIndex(dir);
  const out: Workflow[] = [];
  for (const [id, entry] of Object.entries(index.workflows)) {
    const { workflow } = await loadWorkflowFile(path.join(dir, entry.filename));
    out.push({ ...workflow, id, active: entry.active, isArchived: entry.archived });
  }
  return out;
}
