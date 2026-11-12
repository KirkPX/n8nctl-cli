// `n8nctl activate` and `deactivate`: switch workflows on or off.
// `n8nctl archive` and `unarchive`: move workflows out of the list, or back. Archiving
// keeps the workflow in n8n, where anyone can restore it; `delete` removes it for good.

import pc from "picocolors";
import type { ApiClient } from "../../client.js";
import { ApiError } from "../../errors.js";
import type { Workflow } from "../../workflow/types.js";
import { createClient, createEditor, type ClientOpts } from "../client-helpers.js";
import { assertWritable, printDryRun } from "../guardrails.js";
import { reporter, type Reporter } from "../output.js";
import { resolveWorkflow } from "../resolve.js";

export type StateOpts = ClientOpts & { dryRun?: boolean; readOnly?: boolean; mfaCode?: string };

type Verb = "activate" | "deactivate" | "archive" | "unarchive";

export type StateRow = {
  id: string | null;
  name: string | null;
  input: string;
  outcome: "changed" | "would-change" | "unchanged" | "failed";
  message: string;
};

const DONE: Record<Verb, string> = { activate: "switched on", deactivate: "switched off", archive: "archived", unarchive: "restored" };

/** True when the workflow is already in the state the verb asks for. */
function already(verb: Verb, wf: Workflow): boolean {
  if (verb === "activate") return Boolean(wf.active);
  if (verb === "deactivate") return !wf.active;
  if (verb === "archive") return Boolean(wf.isArchived);
  return !wf.isArchived;
}

export async function stateCommand(verb: Verb, targets: string[], opts: StateOpts = {}): Promise<void> {
  const r = reporter(opts);
  const dryRun = Boolean(opts.dryRun);
  if (!dryRun) assertWritable(opts);
  const client = createClient(opts);

  const found: { input: string; wf: Workflow }[] = [];
  const results: StateRow[] = [];
  for (const input of targets) {
    try {
      found.push({ input, wf: await resolveWorkflow(client, input) });
    } catch (error) {
      results.push({ id: null, name: null, input, outcome: "failed", message: (error as Error).message });
      r.warn(`${input}: ${(error as Error).message}`);
    }
  }

  const needsEditor = (verb === "archive" || verb === "unarchive") && !dryRun && found.some(({ wf }) => !already(verb, wf));
  const editor = needsEditor ? await createEditor(opts, verb) : null;

  for (const { input, wf } of found) {
    const base = { id: wf.id ?? null, name: wf.name ?? null, input };
    const label = `'${wf.name}' (${wf.id})`;
    if (already(verb, wf)) {
      results.push({ ...base, outcome: "unchanged", message: `${label} is already ${DONE[verb]}` });
      continue;
    }
    if (dryRun) {
      const off = verb === "archive" && wf.active ? "switch off, then archive" : verb;
      results.push({ ...base, outcome: "would-change", message: `would ${off} ${label}` });
      continue;
    }
    try {
      await apply(verb, client, editor, wf);
      results.push({ ...base, outcome: "changed", message: `${label} ${DONE[verb]}` });
    } catch (error) {
      results.push({ ...base, outcome: "failed", message: `${label}: ${(error as Error).message}` });
      r.warn(`${label}: ${(error as Error).message}`);
    }
  }
  emit(r, verb, results, dryRun);
}

async function apply(
  verb: Verb,
  client: ApiClient,
  editor: Awaited<ReturnType<typeof createEditor>> | null,
  wf: Workflow
): Promise<void> {
  const id = wf.id!;
  if (verb === "activate") return await client.activateWorkflow(id);
  if (verb === "deactivate") return await client.deactivateWorkflow(id);
  // Archive switches a workflow off first, so its triggers and webhook addresses stop.
  if (verb === "archive" && wf.active) await client.deactivateWorkflow(id);
  if (verb === "archive") await editor!.archiveWorkflow(id);
  else await editor!.unarchiveWorkflow(id);
  // The editor endpoint is not documented, so read the result back.
  const after = await client.getWorkflow(id);
  if (Boolean(after.isArchived) !== (verb === "archive")) {
    throw new ApiError({
      status: 200,
      statusText: "no change",
      operation: `${verb} ${id}`,
      safeDetail: `n8n accepted the request, but the workflow is ${after.isArchived ? "still archived" : "not archived"}`,
      hint: "Check the workflow in the n8n editor. This endpoint is not part of n8n's documented API, so a new n8n version may have changed it.",
    });
  }
}

function emit(r: Reporter, verb: Verb, results: StateRow[], dryRun: boolean): void {
  const failed = results.filter((x) => x.outcome === "failed").length;
  const changed = results.filter((x) => x.outcome === "changed").length;
  const would = results.filter((x) => x.outcome === "would-change").length;
  if (failed) process.exitCode = 1;
  for (const x of results) if (x.outcome !== "failed") r.note(`${x.outcome === "unchanged" ? pc.dim("=") : pc.green("+")} ${x.message}`);
  const summary = dryRun
    ? `${would} workflow(s) would be ${DONE[verb]}`
    : `${changed} workflow(s) ${DONE[verb]}`;
  printDryRun({ changed: changed > 0, summary: failed ? `${summary}; ${failed} failed` : summary }, dryRun, r, {
    ok: failed === 0,
    counts: { total: results.length, succeeded: results.length - failed, failed },
    results,
  });
}
