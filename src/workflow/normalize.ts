// The saved form of a workflow. Every file this CLI writes goes through savedForm(), so
// two backups of an unchanged workflow are byte-identical and Git shows only real edits.

import { createHash } from "node:crypto";
import { sanitizeWorkflow } from "./sanitize.js";
import type { Workflow } from "./types.js";

/** Fields n8n changes on every save or run, which say nothing about what the workflow does. */
const VOLATILE_FIELDS = [
  "versionId",
  "versionCounter",
  "triggerCount",
  "staticData",
  "activeVersionId",
  "activeVersion",
];
const USER_VOLATILE_KEYS = ["lastActiveAt", "updatedAt", "settings"];
const TIMESTAMP_KEYS = ["updatedAt", "createdAt"];

/** Objects with their keys in order, all the way down. */
export function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeys) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out as T;
  }
  return value;
}

function drop(obj: unknown, keys: string[]): void {
  if (obj && typeof obj === "object") for (const k of keys) delete (obj as Record<string, unknown>)[k];
}

/**
 * Remove what changes without a real edit: run counters, version IDs, timestamps on
 * sharing and tags, and the published copy. Nodes are put in ID order. The server's
 * `updatedAt` moves into `_backup_metadata.server_updated_at`.
 */
export function normalizeForDiff(workflow: Workflow): Workflow {
  const out = structuredClone(workflow);
  const updatedAt = out.updatedAt;
  delete out.updatedAt;
  for (const field of VOLATILE_FIELDS) delete out[field];

  if (Array.isArray(out.nodes)) {
    out.nodes.sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
  }
  if (Array.isArray(out.shared)) {
    for (const entry of out.shared as Record<string, unknown>[]) {
      drop(entry, TIMESTAMP_KEYS);
      const project = entry.project as Record<string, unknown> | undefined;
      if (!project) continue;
      drop(project, TIMESTAMP_KEYS);
      for (const rel of (project.projectRelations as Record<string, unknown>[] | undefined) ?? []) {
        drop(rel, TIMESTAMP_KEYS);
        drop(rel.user, USER_VOLATILE_KEYS);
      }
    }
  }
  for (const tag of out.tags ?? []) drop(tag, TIMESTAMP_KEYS);

  const meta: Record<string, unknown> = { ...(out._backup_metadata ?? {}) };
  if (updatedAt) meta.server_updated_at = updatedAt;
  delete meta.backup_timestamp;
  out._backup_metadata = meta;
  return out;
}

/** SHA-256 of the saved form, without its own metadata. Equal hashes mean no real change. */
export function contentHash(workflow: Workflow): string {
  const hashable = { ...normalizeForDiff(sanitizeWorkflow(workflow)) };
  delete hashable._backup_metadata;
  return createHash("sha256").update(JSON.stringify(sortKeys(hashable))).digest("hex");
}

/**
 * The saved form: secrets removed, volatile fields dropped, keys sorted, and the
 * workflow ID and content hash recorded in `_backup_metadata`.
 */
export function savedForm(workflow: Workflow): Workflow {
  const out = normalizeForDiff(sanitizeWorkflow(workflow));
  out._backup_metadata = { ...out._backup_metadata, workflow_id: workflow.id, content_hash: contentHash(workflow) };
  return sortKeys(out);
}

/** The text of a saved file: two-space JSON, no trailing newline (the format older backups use). */
export function savedText(workflow: Workflow): string {
  return JSON.stringify(savedForm(workflow), null, 2);
}

/**
 * A file name that works on every system: characters Windows refuses become `_`, and
 * the name stops at 200 characters. Existing backups use this exact rule, so changing
 * it would save a second copy of every renamed file.
 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "_").substring(0, 200);
}

/** `<name>_<id>.json`, the file name every saved workflow uses. */
export function workflowFilename(workflow: { id?: string; name?: string }): string {
  return `${sanitizeFilename(workflow.name || `workflow_${workflow.id}`)}_${workflow.id}.json`;
}
