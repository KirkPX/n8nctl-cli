// `n8nctl get`: one workflow as JSON, for reading or piping.
//
// By default secrets typed into nodes are replaced by REDACTED_ placeholders, as in
// every file this CLI writes. --keep-secrets prints the workflow exactly as n8n sends
// it, so a script can change one setting and upload it again without losing a value.

import { savedForm } from "../../workflow/normalize.js";
import { createClient, type ClientOpts } from "../client-helpers.js";
import { reporter } from "../output.js";
import { resolveWorkflow } from "../resolve.js";

export async function getCommand(idOrName: string, opts: ClientOpts & { keepSecrets?: boolean } = {}): Promise<void> {
  const r = reporter(opts);
  const wf = await resolveWorkflow(createClient(opts), idOrName);
  if (opts.keepSecrets) {
    r.warn("This output holds the workflow's secrets as n8n has them. Keep it out of Git and shared folders.");
    r.result(wf, JSON.stringify(wf, null, 2));
    return;
  }
  const saved = savedForm(wf);
  r.result(saved, JSON.stringify(saved, null, 2));
}
