// `n8nctl upload`: create or replace workflows from files.
//
// Every file is checked before anything is sent (src/workflow/validate.ts), against the
// file alone and against the live workflow it would replace. --dry-run runs the same
// checks and stops before the write, so a dry run and a real upload refuse the same files.

import pc from "picocolors";
import type { ApiClient } from "../../client.js";
import { ApiError, UsageError } from "../../errors.js";
import { loadWorkflowFile, resolveWorkflowFiles, writeJsonAtomic } from "../../workflow/files.js";
import type { Workflow } from "../../workflow/types.js";
import { checkAgainstServer, checkWorkflow, uploadBody } from "../../workflow/validate.js";
import { createClient, type ClientOpts } from "../client-helpers.js";
import { assertWritable, printDryRun, type MutationOutcome } from "../guardrails.js";
import { reporter } from "../output.js";

export type UploadOpts = ClientOpts & {
  force?: boolean;
  activate?: boolean;
  dryRun?: boolean;
  updateId?: boolean;
  readOnly?: boolean;
};

export type UploadAction =
  | "created"
  | "updated"
  | "would-create"
  | "would-update"
  | "blocked"
  | "exists"
  | "failed";

export type UploadRow = {
  file: string;
  id: string | null;
  name: string | null;
  action: UploadAction;
  activated: boolean;
  errors: string[];
  warnings: string[];
  message: string;
};

export async function uploadCommand(target: string, opts: UploadOpts = {}): Promise<void> {
  const r = reporter(opts);
  const dryRun = Boolean(opts.dryRun);
  if (!dryRun) assertWritable(opts);
  const files = await resolveWorkflowFiles(target);
  const client = createClient(opts);

  let list: Workflow[] | null = null;
  const byName = async (name: string): Promise<Workflow[]> => {
    list ??= await client.listWorkflows();
    return list.filter((w) => !w.isArchived && (w.name ?? "").toLowerCase() === name.toLowerCase());
  };

  const results: UploadRow[] = [];
  for (const file of files) {
    const row = await uploadOne(client, file, opts, byName);
    results.push(row);
    const mark = row.action === "blocked" || row.action === "failed" || row.action === "exists" ? pc.red("X") : pc.green("+");
    r.note(`${mark} ${row.message}`);
    for (const e of row.errors) r.warn(`    ${e}`);
    for (const w of row.warnings) r.note(pc.yellow(`    ! ${w}`));
  }

  const failed = results.filter((x) => ["blocked", "failed", "exists"].includes(x.action)).length;
  const changed = results.filter((x) => x.action === "created" || x.action === "updated").length;
  if (failed) process.exitCode = 1;
  const summary = dryRun
    ? `${results.length - failed} of ${results.length} file(s) would upload`
    : `${changed} of ${results.length} file(s) uploaded`;
  const extra: Partial<MutationOutcome<UploadRow>> = {
    ok: failed === 0,
    counts: { total: results.length, succeeded: results.length - failed, failed },
    results,
  };
  printDryRun({ changed: changed > 0, summary: failed ? `${summary}; ${failed} refused` : summary }, dryRun, r, extra);
}

async function uploadOne(
  client: ApiClient,
  file: string,
  opts: UploadOpts,
  byName: (name: string) => Promise<Workflow[]>
): Promise<UploadRow> {
  const row: UploadRow = { file, id: null, name: null, action: "failed", activated: false, errors: [], warnings: [], message: "" };
  let workflow: Workflow;
  try {
    workflow = (await loadWorkflowFile(file)).workflow;
  } catch (error) {
    return { ...row, errors: [(error as Error).message], message: `${file}: cannot read` };
  }
  row.id = workflow.id ?? null;
  row.name = workflow.name ?? null;
  const label = `${workflow.name ?? file}`;

  const own = checkWorkflow(workflow);
  row.errors.push(...own.errors);
  row.warnings.push(...own.warnings);

  try {
    let existing: Workflow | null = null;
    if (workflow.id) {
      try {
        existing = await client.getWorkflow(workflow.id);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    }
    if (!existing && workflow.name) {
      const matches = await byName(workflow.name);
      if (matches.length > 1) {
        row.errors.push(`${matches.length} workflows on the server are named '${workflow.name}' (${matches.map((m) => m.id).join(", ")}). Put the right ID in the file.`);
      } else if (matches.length === 1) {
        existing = await client.getWorkflow(matches[0]!.id!);
        row.warnings.push(`The file's ID was not found, so it matched the server workflow ${existing.id} by name.`);
      }
    }
    if (existing) {
      row.id = existing.id ?? null;
      const against = checkAgainstServer(workflow, existing);
      row.errors.push(...against.errors);
      row.warnings.push(...against.warnings);
    }
    if (row.errors.length) return { ...row, action: "blocked", message: `${label}: refused, ${row.errors.length} problem(s)` };
    if (existing && !opts.force) {
      return { ...row, action: "exists", errors: [`Workflow ${existing.id} already exists. Pass --force to replace it.`], message: `${label}: already exists` };
    }
    const then = opts.activate ? " and switch it on" : "";
    if (opts.dryRun) {
      return {
        ...row,
        action: existing ? "would-update" : "would-create",
        message: `${label}: would ${existing ? `replace ${existing.id}` : "create a new workflow"}${then}`,
      };
    }

    const body = uploadBody(workflow);
    const saved = existing ? await client.updateWorkflow(existing.id!, body) : await client.createWorkflow(body);
    row.id = saved.id ?? row.id;
    row.action = existing ? "updated" : "created";
    row.message = `${label}: ${row.action} ${row.id}`;

    if (opts.activate && row.id) {
      try {
        await client.activateWorkflow(row.id);
        row.activated = true;
        row.message += ", switched on";
      } catch (error) {
        row.warnings.push(`Saved, but n8n would not switch it on: ${(error as Error).message}`);
      }
    }
    // A new workflow gets its ID from n8n. Write it into the file, so the next upload
    // replaces this workflow instead of creating another.
    if (opts.updateId !== false && row.id && row.id !== workflow.id) {
      await writeJsonAtomic(file, { ...workflow, id: row.id });
      row.warnings.push(`Wrote the new ID ${row.id} into ${file}.`);
    }
    return row;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    return { ...row, action: "failed", errors: [...row.errors, (error as Error).message], message: `${label}: failed` };
  }
}
