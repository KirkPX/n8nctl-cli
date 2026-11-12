// `n8nctl backup <folder>`: save every workflow the key can see, archived ones too,
// plus index.json and each workflow's publish history.
//
// It writes files and nothing else. It does not commit, push or delete: a file whose
// workflow is gone from the server, or was renamed, is listed in `staleFiles` for the
// caller to decide about. The JSON result is a stable contract (docs/json-output.md),
// because scheduled jobs read it.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import type { ApiClient } from "../../client.js";
import { resolveConfig } from "../../config.js";
import { UsageError } from "../../errors.js";
import { readIndex, writeJsonAtomic, writeTextAtomic, type BackupIndex } from "../../workflow/files.js";
import { contentHash, savedText, sortKeys, workflowFilename } from "../../workflow/normalize.js";
import { workflowDetail } from "../../workflow/shape.js";
import type { Workflow } from "../../workflow/types.js";
import { createClient, type ClientOpts } from "../client-helpers.js";
import { reporter } from "../output.js";

export type BackupOpts = ClientOpts & { concurrency?: number; delay?: number };

export const BACKUP_SCHEMA_VERSION = 1;

export type BackupRow = {
  id: string;
  name: string;
  file: string;
  active: boolean;
  archived: boolean;
  updatedAt: string | null;
  contentHash: string;
  changed: boolean;
};

export type BackupResult = {
  schemaVersion: number;
  dir: string;
  index: string;
  startedAt: string;
  completedAt: string;
  complete: boolean;
  counts: { workflows: number; active: number; inactive: number; archived: number; saved: number; changed: number; failed: number };
  workflows: BackupRow[];
  failures: { id: string; name: string; error: string }[];
  staleFiles: { file: string; id: string | null; reason: "not-on-server" | "renamed" }[];
};

export async function backupCommand(dirArg: string | undefined, opts: BackupOpts = {}): Promise<void> {
  const r = reporter(opts);
  const dir = path.resolve(dirArg ?? resolveConfig({ account: opts.account }).workflowsDir);
  const concurrency = opts.concurrency ?? 4;
  if (concurrency < 1) throw new UsageError("--concurrency must be 1 or more.");
  // --delay wins over the delayMs setting; without either, requests are not spaced.
  const client = createClient({ ...opts, ...(opts.delay !== undefined ? { minIntervalMs: opts.delay } : {}) });
  const startedAt = new Date().toISOString();

  const list = await client.listWorkflows();
  r.note(`Found ${list.length} workflows. Saving to ${dir}`);

  const rows: BackupRow[] = [];
  const failures: BackupResult["failures"] = [];
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const item = list[next++]!;
      try {
        rows.push(await saveOne(client, dir, item));
        r.note(`${pc.green("+")} ${item.name}`);
      } catch (error) {
        const message = (error as Error).message;
        failures.push({ id: item.id!, name: item.name ?? "", error: message });
        r.warn(`${item.name} (${item.id}): ${message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(list.length, 1)) }, worker));
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const completedAt = new Date().toISOString();
  const indexFile = path.join(dir, "index.json");
  await writeIndex(dir, list, rows, completedAt);
  const staleFiles = await findStaleFiles(dir, list);

  const result: BackupResult = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    dir,
    index: indexFile,
    startedAt,
    completedAt,
    complete: failures.length === 0,
    counts: {
      workflows: list.length,
      active: list.filter((w) => w.active && !w.isArchived).length,
      inactive: list.filter((w) => !w.active && !w.isArchived).length,
      archived: list.filter((w) => w.isArchived).length,
      saved: rows.length,
      changed: rows.filter((w) => w.changed).length,
      failed: failures.length,
    },
    workflows: rows,
    failures,
    staleFiles,
  };
  if (failures.length) process.exitCode = 1;

  const c = result.counts;
  const lines = [
    `${failures.length ? pc.yellow("Backup incomplete") : pc.green("Backup complete")}: ${c.saved} of ${c.workflows} saved, ${c.changed} changed.`,
    `  ${c.active} on, ${c.inactive} off, ${c.archived} archived.`,
    `  Folder: ${dir}`,
    ...(failures.length ? [`  ${failures.length} failed:`, ...failures.map((f) => `    ${f.name} (${f.id}): ${f.error}`)] : []),
    ...(staleFiles.length ? [`  ${staleFiles.length} file(s) belong to no current workflow (kept): see staleFiles in --json.`] : []),
  ];
  r.result(result, lines.join("\n"));
}

/** Save one workflow, then read the file back and check it, so a bad write is caught here. */
async function saveOne(client: ApiClient, dir: string, item: Workflow): Promise<BackupRow> {
  const wf = await client.getWorkflow(item.id!);
  const file = path.join(dir, workflowFilename(wf));
  const text = savedText(wf);
  let before: string | null = null;
  try {
    before = await readFile(file, "utf-8");
  } catch {
    before = null;
  }
  await recordPublishHistory(dir, wf);
  if (before !== text) await writeTextAtomic(file, text);
  workflowDetail(JSON.parse(await readFile(file, "utf-8")), `saved file ${file}`, wf.id);
  return {
    id: wf.id!,
    name: wf.name ?? "",
    file,
    active: Boolean(item.active),
    archived: Boolean(item.isArchived),
    updatedAt: item.updatedAt ?? null,
    contentHash: contentHash(wf),
    changed: before !== text,
  };
}

/**
 * n8n keeps a list of each time a workflow was published, inside the published copy.
 * The saved form drops that copy, so the list is kept in publish_history/<id>.json,
 * adding new entries and never removing old ones.
 */
async function recordPublishHistory(dir: string, wf: Workflow): Promise<void> {
  const entries = (wf.activeVersion as { workflowPublishHistory?: unknown } | null | undefined)?.workflowPublishHistory;
  if (!Array.isArray(entries) || !entries.length || !wf.id) return;
  const file = path.join(dir, "publish_history", `${wf.id}.json`);
  let existing: { workflow_id: string; workflow_name?: string; entries: Record<string, unknown>[] } = {
    workflow_id: wf.id,
    entries: [],
  };
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8"));
    if (parsed && Array.isArray(parsed.entries)) existing = parsed;
  } catch {
    // No history yet.
  }
  const seen = new Set(existing.entries.map((e) => e.id).filter((v) => v !== undefined));
  for (const e of entries as Record<string, unknown>[]) {
    if (e && e.id !== undefined && !seen.has(e.id)) {
      existing.entries.push(e);
      seen.add(e.id);
    }
  }
  existing.entries.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  existing.workflow_name = wf.name;
  existing.workflow_id = wf.id;
  const text = JSON.stringify(sortKeys(existing), null, 2);
  let before: string | null = null;
  try {
    before = await readFile(file, "utf-8");
  } catch {
    before = null;
  }
  if (before !== text) await writeTextAtomic(file, text);
}

/** index.json: every workflow on the server, and when each was last saved. */
async function writeIndex(dir: string, list: Workflow[], rows: BackupRow[], now: string): Promise<void> {
  let previous: BackupIndex["workflows"] = {};
  try {
    previous = (await readIndex(dir)).workflows;
  } catch {
    previous = {};
  }
  const saved = new Set(rows.map((r) => r.id));
  const workflows: BackupIndex["workflows"] = {};
  for (const wf of list) {
    workflows[wf.id!] = {
      name: wf.name || "Unknown",
      filename: workflowFilename(wf),
      active: Boolean(wf.active),
      archived: Boolean(wf.isArchived),
      serverUpdatedAt: wf.updatedAt ?? null,
      lastBackupAt: saved.has(wf.id!) ? now : (previous[wf.id!]?.lastBackupAt ?? null),
    };
  }
  await writeJsonAtomic(path.join(dir, "index.json"), { lastUpdated: now, workflows });
}

/**
 * Files in the folder that no current workflow writes: deleted on the server, or renamed.
 * The workflow ID is read from inside each file, because n8n IDs can hold `_` and `-`,
 * so the file name alone cannot say where the name ends and the ID starts.
 */
async function findStaleFiles(dir: string, list: Workflow[]): Promise<BackupResult["staleFiles"]> {
  const current = new Set(list.map((w) => workflowFilename(w)));
  const ids = new Set(list.map((w) => w.id!));
  const out: BackupResult["staleFiles"] = [];
  for (const name of (await readdir(dir)).sort()) {
    if (!name.toLowerCase().endsWith(".json") || name === "index.json" || current.has(name)) continue;
    let id: string | null = null;
    try {
      const data = JSON.parse(await readFile(path.join(dir, name), "utf-8"));
      id = typeof data?.id === "string" ? data.id : null;
    } catch {
      id = null;
    }
    out.push({ file: path.join(dir, name), id, reason: id && ids.has(id) ? "renamed" : "not-on-server" });
  }
  return out;
}
