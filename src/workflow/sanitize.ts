// Remove secrets from a workflow before it is written to disk or printed.
//
// n8n keeps real credentials in its own store, and a workflow only points at them. But
// people also type keys and passwords straight into node parameters and Code nodes, and
// those travel with the workflow. A saved copy often goes into Git, so every write path
// in this CLI runs the workflow through sanitizeWorkflow() first.
//
// A removed value is replaced by a marker that starts with REDACTED_. Upload refuses a
// workflow that still holds a marker, because sending it would overwrite the real value.

import type { Workflow, WorkflowNode } from "./types.js";

const SLACK_TOKEN_RE = /xox[bpsa]-[A-Za-z0-9-]+/g;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9\-_.]{20,}/g;
const BASIC_AUTH_RE = /(Basic\s+)[A-Za-z0-9+/=]{20,}/g;
const SK_KEY_RE = /sk[-_](proj|live|test)[-_][A-Za-z0-9\-_]{10,}/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const EMBEDDED_SECRET_RE =
  /("(?:client_secret|clientSecret|client_key|api_secret|apiSecret)"\s*:\s*")[^"]{8,}(")/gi;
// Password-named string literals in code (`pwd: 'x'`, `password = "x"`). A short password
// fails the entropy check below, so these are removed by name. Expressions stay.
const CODE_PASSWORD_RE =
  /(\b(?:pwd|passwd|password|passphrase)['"]?\s*[:=]\s*)(['"`])(?!REDACTED_)((?:(?!\2|\$\{)[^\n\\]|\\.){4,})\2/gi;
// Key-named string literals in code (`const apiKey = '…'`). A UUID-style key also fails
// the entropy check. Whitespace, templates and short values stay.
const CODE_API_KEY_RE =
  /(\b(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|token)['"]?\s*[:=]\s*)(['"`])(?!REDACTED_)([^'"`\s\\$]{12,})\2/gi;

/** Every marker sanitizeWorkflow() writes. */
export const REDACTED_MARKER = /REDACTED_(?:CREDENTIAL|API_KEY|TOKEN|JWT|SLACK_TOKEN)/;

const SENSITIVE_KEYS = new Set([
  "authorization",
  "token",
  "secret",
  "password",
  "apikey",
  "apitoken",
  "accesstoken",
  "clientsecret",
  "bearer",
  "privatekey",
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_]/g, ""));
}

/** Shannon entropy per character. Random keys score high; words and IDs score low. */
export function hasHighEntropy(value: string, threshold = 3.8): boolean {
  if (value.length < 16) return false;
  const freq = new Map<string, number>();
  for (const c of value) freq.set(c, (freq.get(c) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy >= threshold;
}

export function sanitizeString(input: string, parentKey = ""): string {
  const isExpression = input.startsWith("={{") || (input.startsWith("=") && input.includes("{{"));
  let value = input
    .replace(SLACK_TOKEN_RE, "REDACTED_SLACK_TOKEN")
    .replace(BEARER_RE, "$1REDACTED_TOKEN")
    .replace(BASIC_AUTH_RE, "$1REDACTED_TOKEN")
    .replace(SK_KEY_RE, "REDACTED_API_KEY")
    .replace(JWT_RE, "REDACTED_JWT")
    .replace(EMBEDDED_SECRET_RE, "$1REDACTED_CREDENTIAL$2")
    .replace(CODE_PASSWORD_RE, "$1$2REDACTED_CREDENTIAL$2")
    .replace(CODE_API_KEY_RE, "$1$2REDACTED_API_KEY$2");
  if (!isExpression && parentKey && isSensitiveKey(parentKey) && hasHighEntropy(value)) {
    value = "REDACTED_CREDENTIAL";
  }
  return value;
}

function sanitizeValue(value: unknown, parentKey: string): unknown {
  if (typeof value === "string") return sanitizeString(value, parentKey);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, parentKey));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = sanitizeValue(child, key);
    return out;
  }
  return value;
}

function sanitizeNodes(nodes: WorkflowNode[] | undefined): WorkflowNode[] | undefined {
  if (!Array.isArray(nodes)) return nodes;
  return nodes.map((node) => {
    const out: WorkflowNode = { ...node };
    if (node.parameters) out.parameters = sanitizeValue(node.parameters, "") as Record<string, unknown>;
    if (node.headers) out.headers = sanitizeValue(node.headers, "");
    return out;
  });
}

/** A copy of the workflow with secrets in node parameters replaced by markers. */
export function sanitizeWorkflow<T extends Workflow>(workflow: T): T {
  const out = structuredClone(workflow);
  out.nodes = sanitizeNodes(out.nodes);
  if (out.activeVersion && typeof out.activeVersion === "object") {
    out.activeVersion = { ...out.activeVersion, nodes: sanitizeNodes(out.activeVersion.nodes) };
  }
  return out;
}

/** Paths inside the workflow that still hold a REDACTED_ marker, such as `nodes[2].parameters.jsCode`. */
export function findRedactedMarkers(value: unknown, path = ""): string[] {
  if (typeof value === "string") return REDACTED_MARKER.test(value) ? [path || "(value)"] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => findRedactedMarkers(item, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      findRedactedMarkers(child, path ? `${path}.${key}` : key)
    );
  }
  return [];
}
