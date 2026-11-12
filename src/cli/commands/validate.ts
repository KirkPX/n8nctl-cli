// `n8nctl validate`: check workflow files offline, with the same checks upload runs
// before it sends anything. Exit code 1 when any file fails.

import pc from "picocolors";
import { loadWorkflowFile, resolveWorkflowFiles } from "../../workflow/files.js";
import { checkWorkflow } from "../../workflow/validate.js";
import { reporter } from "../output.js";

export type ValidateRow = {
  file: string;
  id: string | null;
  name: string | null;
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export async function validateCommand(target: string, opts: { json?: boolean } = {}): Promise<void> {
  const r = reporter(opts);
  const files = await resolveWorkflowFiles(target);
  const rows: ValidateRow[] = [];
  for (const file of files) {
    try {
      const { workflow } = await loadWorkflowFile(file);
      const check = checkWorkflow(workflow);
      rows.push({ file, id: workflow.id ?? null, name: workflow.name ?? null, ...check });
    } catch (error) {
      rows.push({ file, id: null, name: null, valid: false, errors: [(error as Error).message], warnings: [] });
    }
  }
  const failed = rows.filter((x) => !x.valid).length;
  if (failed) process.exitCode = 1;
  const pretty = rows
    .flatMap((x) => [
      `${x.valid ? pc.green("PASS") : pc.red("FAIL")} ${x.file}`,
      ...x.errors.map((e) => `     ${pc.red("X")} ${e}`),
      ...x.warnings.map((w) => `     ${pc.yellow("!")} ${w}`),
    ])
    .concat("", `${rows.length - failed} of ${rows.length} passed.`)
    .join("\n");
  r.result({ files: rows, counts: { total: rows.length, passed: rows.length - failed, failed } }, pretty);
}
