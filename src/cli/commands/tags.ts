// `n8nctl tags`: list tags, change a workflow's tags, and delete tags.
//
// Changing tags changes only the tags: the workflow itself, and whether it is on, stay
// as they are. A tag named in `set` or `add` that does not exist yet is created.

import pc from "picocolors";
import type { ApiClient } from "../../client.js";
import { ApiError, UsageError } from "../../errors.js";
import type { Tag } from "../../workflow/types.js";
import { createClient, type ClientOpts } from "../client-helpers.js";
import { abortOutcome, assertWritable, confirmDestructive, printDryRun } from "../guardrails.js";
import { reporter } from "../output.js";
import { resolveWorkflow } from "../resolve.js";

type WriteOpts = ClientOpts & { dryRun?: boolean; readOnly?: boolean; yes?: boolean };

export async function tagsListCommand(opts: ClientOpts = {}): Promise<void> {
  const r = reporter(opts);
  const client = createClient(opts);
  const [tags, workflows] = await Promise.all([client.listTags(), client.listWorkflows()]);
  const rows = tags
    .map((t) => {
      const using = workflows.filter((w) => (w.tags ?? []).some((x) => x.id === t.id));
      return { id: t.id, name: t.name, workflows: using.length, activeWorkflows: using.filter((w) => w.active && !w.isArchived).length };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  r.result(
    rows,
    rows.length ? rows.map((t) => `${t.name}  (${t.workflows} workflows, ${t.activeWorkflows} on)  ${pc.dim(t.id)}`).join("\n") : "No tags."
  );
}

type Mode = "set" | "add" | "remove";

/** Change one workflow's tags. `set` replaces them; `add` and `remove` change only those named. */
export async function tagsChangeCommand(mode: Mode, idOrName: string, names: string[], opts: WriteOpts = {}): Promise<void> {
  const r = reporter(opts);
  const dryRun = Boolean(opts.dryRun);
  if (!dryRun) assertWritable(opts);
  if (mode !== "set" && !names.length) throw new UsageError(`Name at least one tag to ${mode}.`);
  const client = createClient(opts);
  const wf = await resolveWorkflow(client, idOrName);
  const before = (wf.tags ?? []).map((t) => t.name);
  const lower = (s: string) => s.toLowerCase();
  let after: string[];
  if (mode === "set") after = unique(names);
  else if (mode === "add") after = unique([...before, ...names]);
  else after = before.filter((t) => !names.map(lower).includes(lower(t)));

  const added = after.filter((t) => !before.map(lower).includes(lower(t)));
  const removed = before.filter((t) => !after.map(lower).includes(lower(t)));
  const label = `'${wf.name}' (${wf.id})`;
  const extra = { id: wf.id, name: wf.name, before, after, added, removed, createdTags: [] as string[] };
  if (!added.length && !removed.length) {
    printDryRun({ changed: false, summary: `${label} tags are already: ${after.join(", ") || "none"}` }, false, r, extra);
    return;
  }
  const change = [added.length ? `add ${added.join(", ")}` : "", removed.length ? `remove ${removed.join(", ")}` : ""].filter(Boolean).join("; ");
  if (dryRun) {
    printDryRun({ changed: true, summary: `Would ${change} on ${label}` }, true, r, extra);
    return;
  }
  const { ids, created } = await tagIds(client, after);
  const saved = (await client.setWorkflowTags(wf.id!, ids)).map((t) => t.name.toLowerCase()).sort();
  // Check n8n's answer, so a silent partial change is caught here.
  if (JSON.stringify(saved) !== JSON.stringify(after.map((t) => t.toLowerCase()).sort())) {
    throw new ApiError({
      status: 200,
      statusText: "unexpected tags",
      operation: `PUT tags of ${wf.id}`,
      safeDetail: `asked for ${after.join(", ") || "no tags"}, n8n now has ${saved.join(", ") || "no tags"}`,
    });
  }
  printDryRun({ changed: true, summary: `Tags on ${label}: ${change}` }, false, r, { ...extra, createdTags: created });
}

/** Delete tags everywhere. n8n removes them from every workflow, archived ones too. */
export async function tagsDeleteCommand(names: string[], opts: WriteOpts = {}): Promise<void> {
  const r = reporter(opts);
  const dryRun = Boolean(opts.dryRun);
  if (!dryRun) assertWritable(opts);
  if (!names.length) throw new UsageError("Name at least one tag to delete.");
  const client = createClient(opts);
  const all = await client.listTags();
  const found: Tag[] = [];
  for (const name of names) {
    const tag = all.find((t) => t.name.toLowerCase() === name.toLowerCase() || t.id === name);
    if (!tag) throw new UsageError(`There is no tag '${name}'.`, "`n8nctl tags list` shows them.");
    found.push(tag);
  }
  const list = found.map((t) => t.name).join(", ");
  const extra = { tags: found.map((t) => ({ id: t.id, name: t.name })) };
  if (dryRun) {
    printDryRun({ changed: true, summary: `Would delete tag(s) ${list} from every workflow` }, true, r, extra);
    return;
  }
  const answer = await confirmDestructive(`Delete tag(s) ${list} from every workflow?`, opts);
  if (!answer.confirmed) {
    const outcome = abortOutcome(answer.reason, `Did not delete ${list}`);
    if (answer.reason === "needs-yes") process.exitCode = 1;
    r.result({ ...outcome, ...extra }, pc.dim(`${outcome.summary}.${outcome.hint ? ` ${outcome.hint}` : ""}`));
    return;
  }
  for (const t of found) await client.deleteTag(t.id);
  printDryRun({ changed: true, summary: `Deleted tag(s) ${list}` }, false, r, extra);
}

function unique(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((n) => n.trim()).filter((n) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
}

/** Tag IDs for names, creating any tag that does not exist yet. */
async function tagIds(client: ApiClient, names: string[]): Promise<{ ids: string[]; created: string[] }> {
  const all = await client.listTags();
  const ids: string[] = [];
  const created: string[] = [];
  for (const name of names) {
    let tag = all.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!tag) {
      tag = await client.createTag(name);
      created.push(tag.name);
    }
    ids.push(tag.id);
  }
  return { ids, created };
}
