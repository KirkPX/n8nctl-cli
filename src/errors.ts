// Typed errors and secret redaction. Every failure in this CLI is one of these, so
// the top-level handler in index.ts formats them the same way. Errors carry the
// operation, the status and a safe detail, and never a token or a credential.

export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly operation: string;
  readonly safeDetail: string;

  constructor(opts: {
    status: number;
    statusText: string;
    operation: string;
    safeDetail: string;
    hint?: string;
  }) {
    super(
      `${opts.operation} failed: ${opts.status} ${opts.statusText} — ${opts.safeDetail}`
    );
    this.name = "ApiError";
    this.status = opts.status;
    this.statusText = opts.statusText;
    this.operation = opts.operation;
    this.safeDetail = opts.safeDetail;
    this.hint = opts.hint ?? apiErrorHint(opts.status);
  }

  readonly hint: string | undefined;
}

/** The next step for a refusal, so a person never sees a bare status code. */
function apiErrorHint(status: number): string | undefined {
  if (status === 401) {
    return "n8n refused the API key. Create a new key in n8n (Settings > n8n API), then run `n8nctl login --force`. If you set N8NCTL_API_KEY, check it instead.";
  }
  if (status === 403) {
    return "This is a permission problem: the key works, but n8n does not let it do this. An API key with fewer scopes, or a user without access to this project, gets this answer.";
  }
  if (status === 404) return "Check the ID or the path.";
  if (status === 400 || status === 422) {
    return "The service could not accept the values sent. The reason above says which.";
  }
  if (status === 429) return "The service is limiting requests. Wait a minute, then try again.";
  if (status >= 500) return "The service had a problem answering. Try again in a few minutes.";
  return undefined;
}

export class TimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(opts: { operation: string; timeoutMs: number }) {
    super(`${opts.operation} timed out after ${opts.timeoutMs}ms`);
    this.name = "TimeoutError";
    this.operation = opts.operation;
    this.timeoutMs = opts.timeoutMs;
  }
}

/**
 * The request never got an answer: no connection, an unknown host, a reset.
 * `hint` is the next step, printed by the top-level handler.
 */
export class NetworkError extends Error {
  readonly operation: string;
  readonly host: string;
  readonly hint: string;

  constructor(opts: { operation: string; host: string; cause?: unknown }) {
    const code = (opts.cause as { cause?: { code?: unknown } } | undefined)?.cause?.code;
    const reason = typeof code === "string" ? ` (${code})` : "";
    super(`${opts.operation} could not reach ${opts.host}${reason}.`, { cause: opts.cause });
    this.name = "NetworkError";
    this.operation = opts.operation;
    this.host = opts.host;
    this.hint =
      "Check your internet connection and the n8n address. `n8nctl doctor` shows the address in use.";
  }
}

/**
 * The CLI is not set up correctly, or was invoked in a way it cannot act on.
 * `hint` is the next step, printed by the top-level handler.
 */
export class ConfigError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ConfigError";
    this.hint = hint;
  }
}

/**
 * A malformed invocation: a bad flag value, a missing required combination.
 *
 * A subclass of ConfigError, so anything matching on ConfigError still matches,
 * with a name that says what went wrong.
 */
export class UsageError extends ConfigError {
  constructor(message: string, hint?: string) {
    super(message, hint);
    this.name = "UsageError";
  }
}

/** Sign-in could not complete. */
export class LoginError extends ConfigError {
  constructor(message: string, hint?: string) {
    super(message, hint);
    this.name = "LoginError";
  }
}

/**
 * The person pressed Ctrl-C at a prompt. The top-level handler exits 130, the code
 * a shell gives a command stopped by Ctrl-C.
 */
export class InterruptedError extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "InterruptedError";
  }
}

/** A file system failure in plain words, for a message that also names the file. */
export function fileErrorReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return "the file or its folder does not exist";
  if (code === "EISDIR") return "it is a folder, not a file";
  // Windows reports a file in the way of a folder as EEXIST when making the folder.
  if (code === "ENOTDIR" || code === "EEXIST") return "part of the path is a file, not a folder";
  if (code === "EACCES" || code === "EPERM") return "you do not have permission";
  if (code === "EROFS") return "the disk is read-only";
  if (code === "ENOSPC") return "the disk is full";
  return code ?? (err instanceof Error ? err.message : "unknown error");
}

/** Mask the middle of a secret, keeping a few edge characters to identify it. */
export function redact(value: string, show = 4): string {
  if (value.length <= show + 4) return "****";
  return value.slice(0, show) + "****" + value.slice(-show);
}

/** Strip inline URL credentials (user:pass@host) from any message before it is printed. */
export function safeErrorMessage(raw: string): string {
  return raw.replace(/(?<=:\/{2})[^@\s/]+@/g, "****@");
}
