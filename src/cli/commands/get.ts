// `n8nctl get`: one workflow as JSON, with secrets removed, for reading or piping.

import { savedForm } from "../../workflow/normalize.js";
import { createClient, type ClientOpts } from "../client-helpers.js";
import { reporter } from "../output.js";
import { resolveWorkflow } from "../resolve.js";

export async function getCommand(idOrName: string, opts: ClientOpts = {}): Promise<void> {
  const r = reporter(opts);
  const wf = await resolveWorkflow(createClient(opts), idOrName);
  const saved = savedForm(wf);
  r.result(saved, JSON.stringify(saved, null, 2));
}
