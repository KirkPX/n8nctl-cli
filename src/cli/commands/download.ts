// `n8nctl download`: save one, several or all workflows as files, secrets removed.

import path from "node:path";
import pc from "picocolors";
import { resolveConfig } from "../../config.js";
import { UsageError } from "../../errors.js";
import { writeWorkflowFile } from "../../workflow/files.js";
import { createClient, type ClientOpts } from "../client-helpers.js";
import { reporter } from "../output.js";
import { resolveWorkflow } from "../resolve.js";

export type DownloadOpts = ClientOpts & { all?: boolean; dir?: string };

type Saved = { id: string; name: string; file: string };
type Failed = { workflow: string; error: string };

export async function downloadCommand(targets: string[], opts: DownloadOpts = {}): Promise<void> {
  const r = reporter(opts);
  if (!opts.all && !targets.length) throw new UsageError("Name a workflow by ID or name, or pass --all.");
  if (opts.all && targets.length) throw new UsageError("Pass workflows or --all, not both.");
  const dir = opts.dir ?? resolveConfig({ account: opts.account }).workflowsDir;
  const client = createClient(opts);

  const ids = opts.all ? (await client.listWorkflows()).map((w) => w.id!) : targets;
  const saved: Saved[] = [];
  const failed: Failed[] = [];
  for (const target of ids) {
    try {
      const wf = opts.all ? await client.getWorkflow(target) : await resolveWorkflow(client, target);
      const file = await writeWorkflowFile(dir, wf);
      saved.push({ id: wf.id!, name: wf.name ?? "", file });
      r.note(`${pc.green("Saved")} ${file}`);
    } catch (error) {
      const message = (error as Error).message;
      failed.push({ workflow: target, error: message });
      r.warn(`${target}: ${message}`);
    }
  }
  if (failed.length) process.exitCode = 1;
  r.result(
    { dir: path.resolve(dir), saved, failed },
    `Saved ${saved.length} workflow${saved.length === 1 ? "" : "s"} to ${path.resolve(dir)}${failed.length ? pc.yellow(`; ${failed.length} failed`) : ""}.`
  );
}
