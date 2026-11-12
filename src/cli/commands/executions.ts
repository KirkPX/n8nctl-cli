// `n8nctl executions` lists recent runs; `n8nctl execution <id>` shows one.
// n8n keeps runs only as long as its own pruning settings say, often a few days.

import { createClient, type ClientOpts } from "../client-helpers.js";
import { reporter } from "../output.js";
import { looksLikeId, resolveWorkflow } from "../resolve.js";

/** The statuses n8n's API accepts. `failed` is a common word for `error`, so it is accepted too. */
export const EXECUTION_STATUSES = ["canceled", "error", "running", "success", "waiting"] as const;

export type ExecutionsOpts = ClientOpts & { status?: string; limit?: number };

export async function executionsCommand(workflow: string | undefined, opts: ExecutionsOpts = {}): Promise<void> {
  const r = reporter(opts);
  const client = createClient(opts);
  const workflowId = workflow
    ? looksLikeId(workflow)
      ? workflow
      : (await resolveWorkflow(client, workflow)).id
    : undefined;
  const status = opts.status === "failed" ? "error" : opts.status;
  const runs = await client.listExecutions({ workflowId, status, limit: opts.limit ?? 20 });
  const pretty = runs.length
    ? runs
        .map((e) => `${e.id.padEnd(8)}  ${e.status.padEnd(8)}  ${(e.startedAt ?? "").slice(0, 19).padEnd(19)}  ${(e.mode ?? "").padEnd(8)}  ${e.workflowId}`)
        .join("\n")
    : "No runs found. n8n deletes old runs on its own schedule.";
  r.result(runs, pretty);
}

export async function executionCommand(id: string, opts: ClientOpts & { includeData?: boolean } = {}): Promise<void> {
  const r = reporter(opts);
  const run = await createClient(opts).getExecution(id, { includeData: opts.includeData });
  r.result(run);
}
