// Finding the workflow a person means. People type IDs and names interchangeably, so
// every command that takes a workflow accepts both.

import type { ApiClient } from "../client.js";
import { ApiError, UsageError } from "../errors.js";
import type { Workflow } from "../workflow/types.js";

/** n8n workflow IDs are letters and digits, usually 16 of them. */
export function looksLikeId(value: string): boolean {
  return /^[A-Za-z0-9]{10,40}$/.test(value);
}

/**
 * The full workflow for an ID or an exact name (any case). A name must match exactly
 * one workflow that is not archived; otherwise the error lists the candidates.
 */
export async function resolveWorkflow(client: ApiClient, idOrName: string): Promise<Workflow> {
  if (looksLikeId(idOrName)) {
    try {
      return await client.getWorkflow(idOrName);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }
  const wanted = idOrName.toLowerCase();
  const all = await client.listWorkflows();
  const matches = all.filter((w) => (w.name ?? "").toLowerCase() === wanted);
  const live = matches.filter((w) => !w.isArchived);
  const pick = live.length ? live : matches;
  if (pick.length === 1) return await client.getWorkflow(pick[0]!.id!);
  if (pick.length > 1) {
    throw new UsageError(
      `${pick.length} workflows are named '${idOrName}'.`,
      `Use the ID: ${pick.map((w) => `${w.id}${w.isArchived ? " (archived)" : ""}`).join(", ")}.`
    );
  }
  throw new UsageError(`No workflow has the ID or name '${idOrName}'.`, "`n8nctl list --name <text>` finds workflows by part of the name.");
}

/** Read --data: inline JSON, `@file`, or `-` for standard input. Undefined when absent. */
export async function readData(value: string | undefined): Promise<unknown> {
  if (value === undefined) return undefined;
  const { readJsonBody } = await import("./read-file.js");
  return await readJsonBody({ data: value });
}
