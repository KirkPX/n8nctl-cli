// Reading and writing workflow files. Paths are built with `path` and names are
// treated as Unicode, so a folder such as "Flüsse und Abläufe" works on every system.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError, UsageError, fileErrorReason } from "../errors.js";
import { savedText, sortKeys, workflowFilename } from "./normalize.js";
import type { Workflow } from "./types.js";

export type LoadedFile = { file: string; workflow: Workflow };

/** Read one workflow file. A failure says which file and why, in plain words. */
export async function loadWorkflowFile(file: string): Promise<LoadedFile> {
  let text: string;
  try {
    text = await readFile(file, "utf-8");
  } catch (error) {
    throw new UsageError(`Cannot read ${file}: ${fileErrorReason(error)}.`);
  }
  let data: unknown;
  try {
    // Windows PowerShell can save a byte-order mark at the start of a file.
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new UsageError(`${file} is not valid JSON: ${(error as Error).message}.`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new UsageError(`${file} does not hold a workflow: it must be one JSON object.`);
  }
  return { file, workflow: data as Workflow };
}

/** Files that are not workflows, even though they end in .json. */
const NOT_WORKFLOWS = new Set(["index.json"]);

/** A file, or every workflow file directly inside a folder, in name order. */
export async function resolveWorkflowFiles(target: string): Promise<string[]> {
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    throw new UsageError(`Cannot read ${target}: ${fileErrorReason(error)}.`);
  }
  if (info.isFile()) {
    if (!target.toLowerCase().endsWith(".json")) throw new UsageError(`${target} is not a .json file.`);
    return [target];
  }
  const names = (await readdir(target))
    .filter((n) => n.toLowerCase().endsWith(".json") && !NOT_WORKFLOWS.has(n))
    .sort();
  if (!names.length) throw new UsageError(`${target} holds no .json workflow files.`);
  return names.map((n) => path.join(target, n));
}

/**
 * Write a workflow in saved form. The file goes to a temporary name first and is
 * then renamed, so a stopped run never leaves half a file.
 */
export async function writeWorkflowFile(dir: string, workflow: Workflow): Promise<string> {
  const file = path.join(dir, workflowFilename(workflow));
  await writeTextAtomic(file, savedText(workflow));
  return file;
}

export async function writeTextAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(tmp, text, "utf-8");
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw new ConfigError(`Cannot write ${file}: ${fileErrorReason(error)}.`);
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeTextAtomic(file, JSON.stringify(sortKeys(value), null, 2));
}

/**
 * The saved file for a workflow, by ID or by name. An ID matches the end of the
 * file name; otherwise the files are read and matched by ID or by part of the name.
 */
export async function findLocalFile(dir: string, idOrName: string): Promise<LoadedFile[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".json") && !NOT_WORKFLOWS.has(n));
  } catch (error) {
    throw new UsageError(`Cannot read the workflows folder ${dir}: ${fileErrorReason(error)}.`, "Pass --dir, or run `n8nctl backup` first.");
  }
  const byId = names.filter((n) => n.endsWith(`_${idOrName}.json`));
  if (byId.length) return await Promise.all(byId.map((n) => loadWorkflowFile(path.join(dir, n))));
  const needle = idOrName.toLowerCase();
  const out: LoadedFile[] = [];
  for (const n of names) {
    try {
      const loaded = await loadWorkflowFile(path.join(dir, n));
      const wf = loaded.workflow;
      if (wf.id === idOrName || (wf.name ?? "").toLowerCase().includes(needle)) out.push(loaded);
    } catch {
      // A file that is not a workflow cannot match.
    }
  }
  return out;
}

export type IndexEntry = {
  name: string;
  filename: string;
  active: boolean;
  archived: boolean;
  serverUpdatedAt: string | null;
  lastBackupAt: string | null;
};

export type BackupIndex = { lastUpdated: string; workflows: Record<string, IndexEntry> };

/** index.json from a backup folder. It is checked, so a changed format stops the reader. */
export async function readIndex(dir: string): Promise<BackupIndex> {
  const file = path.join(dir, "index.json");
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, "utf-8"));
  } catch (error) {
    const reason = error instanceof SyntaxError ? "it is not valid JSON" : fileErrorReason(error);
    throw new UsageError(`Cannot read ${file}: ${reason}.`, "Run `n8nctl backup <folder>` to write it.");
  }
  const index = data as Partial<BackupIndex>;
  if (!index || typeof index.lastUpdated !== "string" || !index.workflows || typeof index.workflows !== "object") {
    throw new UsageError(`${file} has no 'lastUpdated' date or 'workflows' list.`, "Run `n8nctl backup <folder>` to write it again.");
  }
  for (const [id, entry] of Object.entries(index.workflows)) {
    if (!entry || typeof entry.filename !== "string" || typeof entry.name !== "string") {
      throw new UsageError(`${file}: the entry for ${id} has no 'filename' or 'name'.`);
    }
  }
  return index as BackupIndex;
}
