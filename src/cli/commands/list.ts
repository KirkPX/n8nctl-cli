// `n8nctl list`: the workflows on the server, or in a backup folder with --local.

import path from "node:path";
import pc from "picocolors";
import { resolveConfig } from "../../config.js";
import { UsageError } from "../../errors.js";
import { readIndex } from "../../workflow/files.js";
import { savedForm } from "../../workflow/normalize.js";
import type { Workflow } from "../../workflow/types.js";
import { createClient, type ClientOpts } from "../client-helpers.js";
import { reporter } from "../output.js";

export type ListOpts = ClientOpts & {
  active?: boolean;
  inactive?: boolean;
  archived?: boolean;
  excludeArchived?: boolean;
  name?: string;
  tag?: string[];
  local?: boolean;
  dir?: string;
  full?: boolean;
};

/** One row of `list`. The JSON form is documented in docs/json-output.md. */
export type ListRow = {
  id: string;
  name: string;
  active: boolean;
  archived: boolean;
  tags: string[];
  nodeCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  file: string | null;
  /** With --full: the whole workflow in saved form, secrets removed. */
  workflow?: Workflow;
};

export async function listCommand(opts: ListOpts = {}): Promise<void> {
  const r = reporter(opts);
  if (opts.full && opts.local) throw new UsageError("--full reads n8n; a backup folder already holds the full workflows.");
  let rows = opts.local ? await localRows(opts) : await liveRows(opts);
  if (opts.active) rows = rows.filter((w) => w.active);
  if (opts.inactive) rows = rows.filter((w) => !w.active);
  if (opts.archived) rows = rows.filter((w) => w.archived);
  if (opts.excludeArchived) rows = rows.filter((w) => !w.archived);
  if (opts.name) {
    const needle = opts.name.toLowerCase();
    rows = rows.filter((w) => w.name.toLowerCase().includes(needle));
  }
  if (opts.local && opts.tag?.length) {
    r.warn("--tag needs the live server; a backup index holds no tags. Ignoring --tag.");
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  r.result(rows, table(rows));
}

async function liveRows(opts: ListOpts): Promise<ListRow[]> {
  const client = createClient(opts);
  // n8n applies these two filters itself. Name and archive filters are applied here,
  // because n8n's name filter matches differently across versions.
  const workflows = await client.listWorkflows({
    active: opts.active ? true : opts.inactive ? false : undefined,
    tags: opts.tag,
  });
  // n8n's list answer already holds each whole workflow, so --full costs no extra request.
  return workflows.map((w) => (opts.full ? { ...toRow(w), workflow: savedForm(w) } : toRow(w)));
}

export function toRow(w: Workflow): ListRow {
  return {
    id: w.id!,
    name: w.name ?? "",
    active: Boolean(w.active),
    archived: Boolean(w.isArchived),
    tags: (w.tags ?? []).map((t) => t.name),
    nodeCount: Array.isArray(w.nodes) ? w.nodes.length : null,
    createdAt: w.createdAt ?? null,
    updatedAt: w.updatedAt ?? null,
    file: null,
  };
}

async function localRows(opts: ListOpts): Promise<ListRow[]> {
  const dir = opts.dir ?? resolveConfig({ account: opts.account }).workflowsDir;
  const index = await readIndex(dir);
  reporter(opts).note(pc.dim(`From ${path.resolve(dir, "index.json")}, saved ${index.lastUpdated}.`));
  return Object.entries(index.workflows).map(([id, e]) => ({
    id,
    name: e.name,
    active: Boolean(e.active),
    archived: Boolean(e.archived),
    tags: [],
    nodeCount: null,
    createdAt: null,
    updatedAt: e.serverUpdatedAt ?? null,
    file: path.join(dir, e.filename),
  }));
}

function table(rows: ListRow[]): string {
  if (!rows.length) return "No workflows found.";
  const nameWidth = Math.min(Math.max(...rows.map((w) => w.name.length), 4), 50);
  const idWidth = Math.max(...rows.map((w) => w.id.length), 2);
  const head = `${"Name".padEnd(nameWidth)}  ${"ID".padEnd(idWidth)}  ${"State".padEnd(8)}  ${"Nodes".padStart(5)}  Updated`;
  const lines = rows.map((w) => {
    const name = w.name.length > nameWidth ? `${w.name.slice(0, nameWidth - 1)}…` : w.name;
    const state = w.archived ? "archived" : w.active ? "on" : "off";
    const nodes = w.nodeCount === null ? "-" : String(w.nodeCount);
    return `${name.padEnd(nameWidth)}  ${w.id.padEnd(idWidth)}  ${state.padEnd(8)}  ${nodes.padStart(5)}  ${(w.updatedAt ?? "").slice(0, 19)}`;
  });
  return [head, "-".repeat(head.length), ...lines, "", `${rows.length} workflow${rows.length === 1 ? "" : "s"}`].join("\n");
}
