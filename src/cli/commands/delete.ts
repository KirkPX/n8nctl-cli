// `n8nctl delete`: remove a workflow for good. `archive` is the reversible choice.

import pc from "picocolors";
import { createClient, type ClientOpts } from "../client-helpers.js";
import { abortOutcome, assertWritable, confirmDestructive, printDryRun } from "../guardrails.js";
import { reporter } from "../output.js";
import { resolveWorkflow } from "../resolve.js";

export type DeleteOpts = ClientOpts & { yes?: boolean; dryRun?: boolean; readOnly?: boolean };

export async function deleteCommand(idOrName: string, opts: DeleteOpts = {}): Promise<void> {
  const r = reporter(opts);
  const dryRun = Boolean(opts.dryRun);
  if (!dryRun) assertWritable(opts);
  const client = createClient(opts);
  const wf = await resolveWorkflow(client, idOrName);
  const label = `'${wf.name}' (${wf.id})`;
  const extra = { id: wf.id, name: wf.name };
  if (dryRun) {
    printDryRun({ changed: true, summary: `Would delete ${label} for good` }, true, r, extra);
    return;
  }
  const answer = await confirmDestructive(
    `Delete ${label} for good? It cannot be restored. (\`n8nctl archive\` keeps it.)`,
    opts
  );
  if (!answer.confirmed) {
    const outcome = abortOutcome(answer.reason, `Did not delete ${label}`);
    if (answer.reason === "needs-yes") process.exitCode = 1;
    r.result({ ...outcome, ...extra }, pc.dim(`${outcome.summary}.${outcome.hint ? ` ${outcome.hint}` : ""}`));
    return;
  }
  await client.deleteWorkflow(wf.id!);
  printDryRun({ changed: true, summary: `Deleted ${label}` }, false, r, extra);
}
