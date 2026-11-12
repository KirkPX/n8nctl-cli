// Starting workflows. Each has real side effects, so each refuses in read-only mode
// and supports --dry-run, which shows the plan and sends nothing.
//
//   trigger <workflow>   calls the workflow's own Webhook node, as an outside system would
//   run <workflow>       does what the editor's "Execute workflow" button does (needs `login --email`)
//   retry <execution>    runs a failed execution again with its original input

import pc from "picocolors";
import type { ApiClient } from "../../client.js";
import { UsageError } from "../../errors.js";
import { buildManualRun, planWebhookTrigger } from "../../workflow/plan.js";
import type { Execution } from "../../workflow/types.js";
import { createClient, createEditor, createWebhookClient, type ClientOpts } from "../client-helpers.js";
import { assertWritable, printDryRun } from "../guardrails.js";
import { reporter, type Reporter } from "../output.js";
import { readData, resolveWorkflow } from "../resolve.js";

type Common = ClientOpts & { dryRun?: boolean; readOnly?: boolean; wait?: boolean; waitSeconds?: number };

const FINISHED = new Set(["success", "error", "crashed", "canceled", "waiting"]);
const POLL_MS = 3_000;

/**
 * Check until the run finishes, or until the time runs out. A run that ends in
 * anything but success, or a pause at a Wait node, sets exit code 1.
 */
async function waitFor(
  r: Reporter,
  find: () => Promise<Execution | null | undefined>,
  seconds: number
): Promise<Execution | null> {
  r.note("Waiting for the run to finish...");
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const run = await find();
    if (run && FINISHED.has(run.status)) {
      if (run.status !== "success" && run.status !== "waiting") process.exitCode = 1;
      return run;
    }
    if (Date.now() >= until) {
      process.exitCode = 1;
      r.warn(`No finished run after ${seconds} seconds. \`n8nctl executions\` shows it when it ends.`);
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function getOrNull(client: ApiClient, id: string): Promise<Execution | null> {
  try {
    return await client.getExecution(id);
  } catch {
    return null;
  }
}

function runLine(run: Execution | null): string {
  if (!run) return "";
  const colour = run.status === "success" ? pc.green : run.status === "waiting" ? pc.yellow : pc.red;
  return `\nExecution ${run.id}: ${colour(run.status)}`;
}

export async function triggerCommand(idOrName: string, opts: Common & { data?: string; node?: string } = {}): Promise<void> {
  const r = reporter(opts);
  const dryRun = Boolean(opts.dryRun);
  if (!dryRun) assertWritable(opts);
  const data = await readData(opts.data);
  const client = createClient(opts);
  const wf = await resolveWorkflow(client, idOrName);
  const plan = planWebhookTrigger(wf, { nodeName: opts.node });
  if (!plan.ok) throw new UsageError(plan.error);
  const target = `${plan.method} /webhook/${plan.path} (node '${plan.node}')`;
  const extra = { workflowId: wf.id, name: wf.name, method: plan.method, path: plan.path, node: plan.node };
  if (dryRun) {
    printDryRun({ changed: true, summary: `Would call ${target} of '${wf.name}'` }, true, r, extra);
    return;
  }

  // The webhook does not say which execution it started. Find the newest run of this
  // workflow that started after the call; five seconds allow for clock difference.
  const startedAfter = Date.now() - 5_000;
  const response = await createWebhookClient(opts).call({ method: plan.method, path: plan.path, data: data ?? {} });
  const ok = response.status < 400;
  if (!ok) process.exitCode = 1;
  let execution: Execution | null = null;
  if (ok && opts.wait) {
    execution = await waitFor(
      r,
      async () =>
        (await client.listExecutions({ workflowId: wf.id, limit: 20 }))
          .filter((e) => e.startedAt && Date.parse(e.startedAt) >= startedAfter)
          .sort((a, b) => Date.parse(b.startedAt ?? "") - Date.parse(a.startedAt ?? ""))[0],
      opts.waitSeconds ?? 300
    );
  }
  const body = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
  printDryRun(
    { changed: ok, summary: `Webhook ${target} answered ${response.status}` },
    false,
    r,
    { ...extra, ok, status: response.status, response: response.data, execution }
  );
  if (body && body !== "null") r.line(`Response: ${body.length > 500 ? `${body.slice(0, 500)}…` : body}`);
  if (execution) r.line(runLine(execution));
}

export async function runCommand(
  idOrName: string,
  opts: Common & { data?: string; trigger?: string; mfaCode?: string } = {}
): Promise<void> {
  const r = reporter(opts);
  const dryRun = Boolean(opts.dryRun);
  if (!dryRun) assertWritable(opts);
  const data = await readData(opts.data);
  const client = createClient(opts);
  const wf = await resolveWorkflow(client, idOrName);
  const plan = buildManualRun(wf, { triggerName: opts.trigger, data });
  if (!plan.ok) throw new UsageError(plan.error);
  const what = `'${wf.name}' from trigger '${plan.trigger}' (${plan.version} version${data !== undefined ? ", with --data as its output" : ""})`;
  const otherPins = plan.pinned.filter((n) => !(data !== undefined && n === plan.trigger));
  if (otherPins.length) r.warn(`Data pinned in the editor replaces the output of: ${otherPins.join(", ")}.`);
  const extra = { workflowId: wf.id, name: wf.name, trigger: plan.trigger, version: plan.version, pinned: plan.pinned };
  if (dryRun) {
    printDryRun({ changed: true, summary: `Would run ${what}` }, true, r, extra);
    return;
  }

  const editor = await createEditor(opts, "run");
  const started = await editor.runManually(wf.id!, plan.payload);
  if (started?.waitingForWebhook) {
    await editor.cancelTestWebhook(wf.id!).catch(() => undefined);
    throw new UsageError(
      `Trigger '${plan.trigger}' waits for an outside call, so nothing ran.`,
      `Give it input with --data, or use \`n8nctl trigger ${wf.id}\`.`
    );
  }
  if (!started?.executionId) throw new UsageError(`n8n did not say which execution it started: ${JSON.stringify(started).slice(0, 200)}`);
  const executionId = String(started.executionId);
  const execution = opts.wait ? await waitFor(r, () => getOrNull(client, executionId), opts.waitSeconds ?? 300) : null;
  printDryRun({ changed: true, summary: `Started execution ${executionId}: ${what}` }, false, r, { ...extra, executionId, execution });
  if (execution) r.line(runLine(execution));
}

export async function retryCommand(executionId: string, opts: Common & { latest?: boolean } = {}): Promise<void> {
  const r = reporter(opts);
  const dryRun = Boolean(opts.dryRun);
  if (!dryRun) assertWritable(opts);
  const client = createClient(opts);
  const past = await client.getExecution(executionId);
  if (past.status === "success") {
    throw new UsageError(
      `Execution ${executionId} succeeded, and n8n retries only runs that failed.`,
      `To run the workflow again, use \`n8nctl run ${past.workflowId}\`.`
    );
  }
  const what = `execution ${executionId} of workflow ${past.workflowId} (was ${past.status}), on the ${opts.latest ? "workflow as it is now" : "workflow as it ran then"}`;
  const extra = { retryOf: executionId, workflowId: past.workflowId };
  if (dryRun) {
    printDryRun({ changed: true, summary: `Would retry ${what}` }, true, r, extra);
    return;
  }
  const run = await client.retryExecution(executionId, { loadWorkflow: opts.latest });
  const execution = opts.wait ? await waitFor(r, () => getOrNull(client, run.id), opts.waitSeconds ?? 300) : null;
  printDryRun({ changed: true, summary: `Started execution ${run.id}, retrying ${what}` }, false, r, { ...extra, executionId: run.id, execution });
  if (execution) r.line(runLine(execution));
}
