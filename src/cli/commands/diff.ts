// `n8nctl diff`: compare a saved workflow file with the live workflow.
// Exit code 1 when they differ, like `git diff --exit-code`, so a script can check.

import path from "node:path";
import { resolveConfig } from "../../config.js";
import { UsageError } from "../../errors.js";
import { diffWorkflows, formatDiff } from "../../workflow/diff.js";
import { findLocalFile, loadWorkflowFile } from "../../workflow/files.js";
import { normalizeForDiff, sanitizeWorkflow } from "../../workflow/index.js";
import { createClient, type ClientOpts } from "../client-helpers.js";
import { reporter } from "../output.js";

export type DiffOpts = ClientOpts & { dir?: string; file?: string };

export async function diffCommand(idOrName: string | undefined, opts: DiffOpts = {}): Promise<void> {
  const r = reporter(opts);
  let loaded;
  if (opts.file) {
    loaded = await loadWorkflowFile(opts.file);
  } else {
    if (!idOrName) throw new UsageError("Name the workflow by ID or name, or pass --file <path>.");
    const dir = opts.dir ?? resolveConfig({ account: opts.account }).workflowsDir;
    const matches = await findLocalFile(dir, idOrName);
    if (!matches.length) {
      throw new UsageError(`No saved file in ${dir} matches '${idOrName}'.`, `Run \`n8nctl download ${idOrName}\` first, or pass --dir.`);
    }
    if (matches.length > 1) {
      throw new UsageError(
        `${matches.length} saved files match '${idOrName}'.`,
        `Use the workflow ID, or --file: ${matches.map((m) => m.file).join(", ")}`
      );
    }
    loaded = matches[0]!;
  }
  const local = loaded.workflow;
  if (!local.id) throw new UsageError(`${loaded.file} has no workflow 'id', so there is nothing to compare it with.`);

  const server = await createClient(opts).getWorkflow(local.id);
  // Both sides in saved form, so secrets, timestamps and counters do not count as changes.
  const result = diffWorkflows(normalizeForDiff(sanitizeWorkflow(local)), normalizeForDiff(sanitizeWorkflow(server)));
  if (result.hasDifferences) process.exitCode = 1;
  const file = path.resolve(loaded.file);
  r.result(
    { id: local.id, name: local.name ?? server.name ?? null, file, ...result },
    formatDiff(result, { name: local.name ?? server.name ?? "Unknown", id: local.id, localFile: file })
  );
}
