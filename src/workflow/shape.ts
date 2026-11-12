// n8n's answers are checked on every call, not once in a test. n8n changes between
// versions, and a changed answer read as if nothing changed would write empty or wrong
// backups without any error. A check that fails stops the command and names the field.

import { ApiError } from "../errors.js";
import type { Execution, Tag, Workflow } from "./types.js";

export class ShapeError extends ApiError {
  constructor(operation: string, detail: string) {
    super({
      status: 0,
      statusText: "unexpected answer",
      operation,
      safeDetail: detail,
      hint:
        "n8n answered in a form this version of n8nctl does not know. Check for a newer n8nctl, " +
        "and report the n8n version if there is none.",
    });
    this.name = "ShapeError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** One page of a list: `{ data: [...], nextCursor }`. */
export function page(value: unknown, operation: string): { data: unknown[]; nextCursor: string | null } {
  if (!isObject(value) || !Array.isArray(value.data)) {
    throw new ShapeError(operation, "expected an object with a 'data' list");
  }
  const next = value.nextCursor;
  if (next !== undefined && next !== null && typeof next !== "string") {
    throw new ShapeError(operation, "'nextCursor' is not text");
  }
  return { data: value.data, nextCursor: next ?? null };
}

const ID = /^[A-Za-z0-9_-]+$/;

/** A workflow as the list returns it. */
export function workflowSummary(value: unknown, operation: string): Workflow {
  if (!isObject(value) || typeof value.id !== "string" || !ID.test(value.id)) {
    throw new ShapeError(operation, "a workflow has no usable 'id'");
  }
  if (typeof value.name !== "string") throw new ShapeError(operation, `workflow ${value.id} has no 'name'`);
  if (typeof value.active !== "boolean") throw new ShapeError(operation, `workflow ${value.id} has no true/false 'active'`);
  return value as Workflow;
}

/** A full workflow. With `id`, it must be the workflow that was asked for. */
export function workflowDetail(value: unknown, operation: string, id?: string): Workflow {
  const wf = workflowSummary(value, operation);
  if (id && wf.id !== id) throw new ShapeError(operation, `asked for workflow ${id}, got ${wf.id}`);
  if (!Array.isArray(wf.nodes)) throw new ShapeError(operation, `workflow ${wf.id} has no 'nodes' list`);
  if (!isObject(wf.connections)) throw new ShapeError(operation, `workflow ${wf.id} has no 'connections' object`);
  if (wf.nodes.some((n) => !isObject(n) || typeof n.name !== "string" || typeof n.type !== "string")) {
    throw new ShapeError(operation, `workflow ${wf.id} has a node with no name or type`);
  }
  return wf;
}

/** A list of workflows: every ID present and none twice. */
export function workflowList(values: unknown[], operation: string): Workflow[] {
  const seen = new Set<string>();
  return values.map((value) => {
    const wf = workflowSummary(value, operation);
    if (seen.has(wf.id!)) throw new ShapeError(operation, `workflow ${wf.id} is listed twice`);
    seen.add(wf.id!);
    return wf;
  });
}

export function tag(value: unknown, operation: string): Tag {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    throw new ShapeError(operation, "a tag has no 'id' or 'name'");
  }
  return value as Tag;
}

export function execution(value: unknown, operation: string): Execution {
  if (!isObject(value)) throw new ShapeError(operation, "an execution is not an object");
  // n8n sends execution IDs as text in some versions and numbers in others.
  if (typeof value.id !== "string" && typeof value.id !== "number") {
    throw new ShapeError(operation, "an execution has no 'id'");
  }
  if (typeof value.workflowId !== "string") throw new ShapeError(operation, `execution ${value.id} has no 'workflowId'`);
  if (typeof value.status !== "string") throw new ShapeError(operation, `execution ${value.id} has no 'status'`);
  return { ...value, id: String(value.id) } as Execution;
}
