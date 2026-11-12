// `n8nctl static-data`: what a workflow remembers between runs, such as the last item a
// polling trigger saw. Read-only.

import { UsageError } from "../../errors.js";
import { createClient, type ClientOpts } from "../client-helpers.js";
import { reporter } from "../output.js";
import { resolveWorkflow } from "../resolve.js";

export async function staticDataCommand(idOrName: string, opts: ClientOpts & { key?: string } = {}): Promise<void> {
  const r = reporter(opts);
  const wf = await resolveWorkflow(createClient(opts), idOrName);
  const data = wf.staticData ?? null;
  let value: unknown = data;
  if (opts.key) {
    if (!data || typeof data !== "object" || !(opts.key in data)) {
      const keys = data && typeof data === "object" ? Object.keys(data) : [];
      throw new UsageError(
        `'${wf.name}' (${wf.id}) has no saved value '${opts.key}'.`,
        keys.length ? `Its keys: ${keys.join(", ")}.` : "It has no saved values."
      );
    }
    value = (data as Record<string, unknown>)[opts.key];
  }
  const head = `${wf.name} (${wf.id})${opts.key ? `, key ${opts.key}` : ""}`;
  r.result(
    { id: wf.id, name: wf.name, key: opts.key ?? null, value },
    value === null ? `${head}: nothing saved.` : `${head}\n${JSON.stringify(value, null, 2)}`
  );
}
