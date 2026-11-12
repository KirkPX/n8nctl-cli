#!/usr/bin/env node
import { Command } from "commander";
import { parseCount } from "./cli/parse.js";

// Exit cleanly when the reader closes the pipe early (`n8nctl doctor | head -1`).
// Without this, the next write raises an uncaught EPIPE, and the CLI dies with a
// stack trace and a non-zero exit. Any other stream error still propagates.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
}

const VERSION = "0.1.0";

const program = new Command();

// Commander's own errors (a missing option, an unknown command) follow the output
// contract too: one JSON object on stderr when the output is JSON. This is set
// before any subcommand is added, because each subcommand copies it when created.
program.configureOutput({
  outputError: (text, write) => {
    const json = process.argv.includes("--json") || !process.stdout.isTTY;
    if (!json) return write(text);
    const message = text.replace(/^error: /, "").trim();
    write(JSON.stringify({ error: true, message, hint: "Run the command with --help to see its options." }) + "\n");
  },
});

// --json is declared once, here on the root. Commander still accepts it after a
// subcommand (`n8nctl whoami --json`), and each action merges
// `program.opts()` so the value reaches the handler. Declaring it again on a
// subcommand would bind each copy to its own command, and the handler would read
// whichever object is empty.
program
  .name("n8nctl")
  .description("Manage n8n workflows from the terminal: list, back up, compare, upload and run")
  .version(VERSION)
  .option("--json", "emit machine-readable JSON")
  .option("--read-only", "refuse any command that would change remote data")
  .option("--verbose", "emit diagnostic details");

// Running `n8nctl` bare should do the obvious thing: sign you in if you
// never have, and otherwise show what you can do.
program.action(async () => {
  const { isConfigured, loginCommand } = await import("./cli/commands/login.js");
  if (isConfigured()) {
    program.help();
    return;
  }
  const { reporter } = await import("./cli/output.js");
  reporter(program.opts()).note("Welcome to n8nctl. Let's connect it to your n8n.\n");
  await loginCommand(program.opts());
});

// Options every command that talks to n8n takes.
function withTarget(cmd: Command): Command {
  return cmd
    .option("--account <name>", "Saved sign-in to use (default: default)")
    .option("--base-url <url>", "n8n address, for this run only");
}

/** The merged options a handler reads: global flags, then the command's own. */
function merged<T extends object>(opts: T): T & { json?: boolean; readOnly?: boolean; verbose?: boolean } {
  return { ...program.opts(), ...opts };
}

program
  .command("login")
  .description("Sign in to n8n with an API key, or with --email for archive, unarchive and run")
  .option("--paste", "Type the address and key in the terminal instead of a browser page")
  .option("--email", "Sign in with your n8n email and password (needed only by archive, unarchive and run)")
  .option("--mfa-code <code>", "Two-step code from your authenticator app, with --email")
  .option("--force", "Sign in again, even if already signed in")
  .option("--account <name>", "Name for this sign-in, to keep more than one n8n (default: default)")
  .option("--base-url <url>", "n8n address, such as https://n8n.example.com")
  .action(async (opts) => {
    const { loginCommand } = await import("./cli/commands/login.js");
    await loginCommand(merged(opts));
  });

program
  .command("logout")
  .description("Sign out: remove the saved API key and any saved n8n password")
  .option("--account <name>", "Saved sign-in to remove (default: default)")
  .action(async (opts) => {
    const { logoutCommand } = await import("./cli/commands/login.js");
    await logoutCommand(merged(opts));
  });

program
  .command("doctor")
  .description("Check the install, the settings file and the credential store")
  .option("--install", "Close with an install verdict (used by `npm run setup`)")
  .action(async (opts) => {
    const { doctorCommand } = await import("./cli/commands/doctor.js");
    await doctorCommand(merged(opts));
  });

const configCmd = program.command("config").description("Inspect and change the settings file");

configCmd
  .command("path")
  .description("Print where the settings file lives")
  .action(async (opts) => {
    const { configPath } = await import("./cli/commands/config.js");
    await configPath(merged(opts));
  });

configCmd
  .command("show")
  .description("Validate the settings file and print it")
  .action(async (opts) => {
    const { configShow } = await import("./cli/commands/config.js");
    await configShow(merged(opts));
  });

configCmd
  .command("set <name> <value>")
  .description("Set one setting, for example `config set baseUrl https://n8n.example.com`")
  .action(async (name: string, value: string, opts) => {
    const { configSet } = await import("./cli/commands/config.js");
    await configSet(name, value, merged(opts));
  });

configCmd
  .command("unset <name>")
  .description("Remove one setting")
  .action(async (name: string, opts) => {
    const { configUnset } = await import("./cli/commands/config.js");
    await configUnset(name, merged(opts));
  });

program
  .command("auth")
  .description("Manage the stored API key from a script")
  .option("--status", "Show current auth status (default)")
  .option("--login", "Store an API key")
  .option("--logout", "Clear the stored API key and any saved n8n password")
  .option("--api-key <key>", "API key to store")
  .option("--account <name>", "Saved sign-in to use (default: default)")
  .option("--base-url <url>", "n8n address to save with the key")
  .action(async (opts) => {
    const { authCommand } = await import("./cli/commands/auth.js");
    await authCommand(merged(opts));
  });

// ── Reading ──────────────────────────────────────────────────────────────────

withTarget(
  program
    .command("list")
    .description("List workflows on the server, or in a backup folder with --local")
    .option("--active", "Only workflows that are on")
    .option("--inactive", "Only workflows that are off")
    .option("--archived", "Only archived workflows")
    .option("--exclude-archived", "Leave out archived workflows")
    .option("--name <text>", "Only names that contain this text (any case)")
    .option("--tag <name...>", "Only workflows with every one of these tags")
    .option("--local", "Read the backup folder's index.json instead of the server")
    .option("--dir <folder>", "Backup folder for --local (default: the workflowsDir setting)")
).action(async (opts) => {
  const { listCommand } = await import("./cli/commands/list.js");
  await listCommand(merged(opts));
});

withTarget(
  program
    .command("get <workflow>")
    .description("Print one workflow as JSON, secrets removed (ID or exact name)")
    .option("--keep-secrets", "Print it exactly as n8n sends it, secrets included, to change and upload again")
).action(async (workflow: string, opts) => {
  const { getCommand } = await import("./cli/commands/get.js");
  await getCommand(workflow, merged(opts));
});

withTarget(
  program
    .command("download [workflows...]")
    .description("Save workflows as files, secrets removed (IDs or exact names)")
    .option("--all", "Download every workflow")
    .option("--dir <folder>", "Where to save (default: the workflowsDir setting)")
).action(async (workflows: string[], opts) => {
  const { downloadCommand } = await import("./cli/commands/download.js");
  await downloadCommand(workflows, merged(opts));
});

withTarget(
  program
    .command("backup [folder]")
    .description("Save every workflow, index.json and publish history to a folder. Writes files only")
    .option("--concurrency <n>", "Workflows read at once (default: 4)", parseCount)
    .option("--delay <ms>", "Wait between requests, to go easy on a busy n8n (default: the delayMs setting, or 0)", parseCount)
).action(async (folder: string | undefined, opts) => {
  const { backupCommand } = await import("./cli/commands/backup.js");
  await backupCommand(folder, merged(opts));
});

withTarget(
  program
    .command("diff [workflow]")
    .description("Compare a saved workflow file with the live one. Exit code 1 when they differ")
    .option("--dir <folder>", "Folder of saved workflows (default: the workflowsDir setting)")
    .option("--file <path>", "Compare this file instead of looking one up")
).action(async (workflow: string | undefined, opts) => {
  const { diffCommand } = await import("./cli/commands/diff.js");
  await diffCommand(workflow, merged(opts));
});

program
  .command("validate <path>")
  .description("Check workflow files offline, with the checks upload runs first. Exit code 1 on a failure")
  .action(async (target: string, opts) => {
    const { validateCommand } = await import("./cli/commands/validate.js");
    await validateCommand(target, merged(opts));
  });

withTarget(
  program
    .command("executions [workflow]")
    .description("List recent runs, newest first, of one workflow or all")
    .option("--status <status>", "canceled, error (or failed), running, success or waiting")
    .option("--limit <n>", "How many (default: 20)", parseCount)
).action(async (workflow: string | undefined, opts) => {
  const { executionsCommand, EXECUTION_STATUSES } = await import("./cli/commands/executions.js");
  if (opts.status && opts.status !== "failed" && !(EXECUTION_STATUSES as readonly string[]).includes(opts.status)) {
    const { UsageError } = await import("./errors.js");
    throw new UsageError(`--status takes ${EXECUTION_STATUSES.join(", ")} or failed, not "${opts.status}".`);
  }
  await executionsCommand(workflow, merged(opts));
});

withTarget(
  program
    .command("execution <id>")
    .description("Show one run")
    .option("--include-data", "Include each node's input and output")
).action(async (id: string, opts) => {
  const { executionCommand } = await import("./cli/commands/executions.js");
  await executionCommand(id, merged(opts));
});

withTarget(
  program
    .command("static-data <workflow>")
    .description("Show what a workflow remembers between runs")
    .option("--key <key>", "Only this saved value, such as node:Poller")
).action(async (workflow: string, opts) => {
  const { staticDataCommand } = await import("./cli/commands/static-data.js");
  await staticDataCommand(workflow, merged(opts));
});

withTarget(
  program
    .command("credentials")
    .description("List the credentials workflows use, and which workflows use each")
    .option("--local", "Read a backup folder instead of the server")
    .option("--dir <folder>", "Backup folder for --local (default: the workflowsDir setting)")
).action(async (opts) => {
  const { credentialsCommand } = await import("./cli/commands/credentials.js");
  await credentialsCommand(merged(opts));
});

withTarget(
  program
    .command("nodes")
    .description("Count the node types workflows use")
    .option("--local", "Read a backup folder instead of the server")
    .option("--dir <folder>", "Backup folder for --local (default: the workflowsDir setting)")
).action(async (opts) => {
  const { nodesCommand } = await import("./cli/commands/nodes.js");
  await nodesCommand(merged(opts));
});

// ── Changing ─────────────────────────────────────────────────────────────────
// Every command below refuses in read-only mode and takes --dry-run.

withTarget(
  program
    .command("upload <path>")
    .description("Create or replace workflows from a file or a folder of files")
    .option("--force", "Replace a workflow that already exists")
    .option("--activate", "Switch each workflow on after saving it")
    .option("--no-update-id", "Do not write a new workflow's ID back into its file")
    .option("--dry-run", "Run every check and show what would change, then stop")
).action(async (target: string, opts) => {
  const { uploadCommand } = await import("./cli/commands/upload.js");
  await uploadCommand(target, merged(opts));
});

for (const [verb, text] of [
  ["activate", "Switch workflows on"],
  ["deactivate", "Switch workflows off"],
  ["archive", "Switch workflows off and archive them; they stay in n8n and can be restored (needs `login --email`)"],
  ["unarchive", "Restore archived workflows; they stay off (needs `login --email`)"],
] as const) {
  const cmd = withTarget(
    program
      .command(`${verb} <workflows...>`)
      .description(text)
      .option("--dry-run", "Show what would change, then stop")
  );
  if (verb === "archive" || verb === "unarchive") cmd.option("--mfa-code <code>", "Two-step code, if your n8n sign-in uses one");
  cmd.action(async (workflows: string[], opts) => {
    const { stateCommand } = await import("./cli/commands/state.js");
    await stateCommand(verb, workflows, merged(opts));
  });
}

withTarget(
  program
    .command("delete <workflow>")
    .description("Delete a workflow for good. `archive` keeps it")
    .option("--yes", "Do not ask first")
    .option("--dry-run", "Show what would be deleted, then stop")
).action(async (workflow: string, opts) => {
  const { deleteCommand } = await import("./cli/commands/delete.js");
  await deleteCommand(workflow, merged(opts));
});

withTarget(
  program
    .command("trigger <workflow>")
    .description("Call a workflow's Webhook trigger, as an outside system would (a real run)")
    .option("--data <json>", "Body to send: JSON, @file, or - for standard input")
    .option("--node <name>", "Which Webhook node, when there is more than one")
    .option("--wait", "Wait for the run to finish and report it")
    .option("--wait-seconds <n>", "How long --wait waits (default: 300)", parseCount)
    .option("--dry-run", "Show what would be called, then stop")
).action(async (workflow: string, opts) => {
  const { triggerCommand } = await import("./cli/commands/run.js");
  await triggerCommand(workflow, merged(opts));
});

withTarget(
  program
    .command("run <workflow>")
    .description("Run a workflow as the editor's Execute button does (a real run; needs `login --email`)")
    .option("--trigger <name>", "Which trigger to start from, when there is more than one")
    .option("--data <json>", "The trigger's output: JSON, @file, or - for standard input")
    .option("--wait", "Wait for the run to finish and report it")
    .option("--wait-seconds <n>", "How long --wait waits (default: 300)", parseCount)
    .option("--mfa-code <code>", "Two-step code, if your n8n sign-in uses one")
    .option("--dry-run", "Show what would run, then stop")
).action(async (workflow: string, opts) => {
  const { runCommand } = await import("./cli/commands/run.js");
  await runCommand(workflow, merged(opts));
});

withTarget(
  program
    .command("retry <execution>")
    .description("Run a failed execution again with its original input (a real run)")
    .option("--latest", "Use the workflow as it is now, not as it was when it ran")
    .option("--wait", "Wait for the run to finish and report it")
    .option("--wait-seconds <n>", "How long --wait waits (default: 300)", parseCount)
    .option("--dry-run", "Show what would run, then stop")
).action(async (execution: string, opts) => {
  const { retryCommand } = await import("./cli/commands/run.js");
  await retryCommand(execution, merged(opts));
});

const tagsCmd = program.command("tags").description("List tags, change a workflow's tags, delete tags");

withTarget(tagsCmd.command("list").description("Every tag, and how many workflows have it")).action(async (opts) => {
  const { tagsListCommand } = await import("./cli/commands/tags.js");
  await tagsListCommand(merged(opts));
});

for (const [mode, text] of [
  ["set", "Replace a workflow's tags with these (none clears them)"],
  ["add", "Add tags to a workflow; a new tag name is created"],
  ["remove", "Remove tags from a workflow"],
] as const) {
  withTarget(
    tagsCmd
      .command(`${mode} <workflow> ${mode === "set" ? "[tags...]" : "<tags...>"}`)
      .description(text)
      .option("--dry-run", "Show what would change, then stop")
  ).action(async (workflow: string, tags: string[], opts) => {
    const { tagsChangeCommand } = await import("./cli/commands/tags.js");
    await tagsChangeCommand(mode, workflow, tags ?? [], merged(opts));
  });
}

withTarget(
  tagsCmd
    .command("delete <tags...>")
    .description("Delete tags from n8n and from every workflow that has them")
    .option("--yes", "Do not ask first")
    .option("--dry-run", "Show what would be deleted, then stop")
).action(async (tags: string[], opts) => {
  const { tagsDeleteCommand } = await import("./cli/commands/tags.js");
  await tagsDeleteCommand(tags, merged(opts));
});

program.parseAsync(process.argv).catch(async (error: unknown) => {
  const { resolveFormat } = await import("./cli/output.js");
  const { InterruptedError, safeErrorMessage } = await import("./errors.js");

  // Ctrl-C at a prompt: a person is at the terminal and knows why it stopped.
  if (error instanceof InterruptedError) {
    console.error(error.message);
    process.exitCode = 130;
    return;
  }

  const raw = error instanceof Error ? error.message : String(error);
  const message = safeErrorMessage(raw);
  // Login and config failures carry a next step. Printing the cause without it
  // leaves the user guessing.
  const rawHint = (error as { hint?: unknown })?.hint;
  const hint = typeof rawHint === "string" && rawHint ? rawHint : undefined;

  // --verbose adds the stack. In json it goes INSIDE the envelope, not as a
  // second stderr write, so stderr stays parseable as one object.
  const verbose = Boolean(program.opts().verbose);
  const stack = verbose && error instanceof Error ? error.stack : undefined;

  if (resolveFormat(program.opts()) === "json") {
    console.error(
      JSON.stringify({
        error: true,
        message,
        ...(hint ? { hint } : {}),
        ...(stack ? { stack: safeErrorMessage(stack) } : {}),
      })
    );
  } else {
    console.error(`Error: ${message}`);
    if (hint) console.error(hint);
    if (stack) console.error(safeErrorMessage(stack));
  }

  // exitCode, not process.exit: exit() can cut off output still buffered for a pipe.
  process.exitCode = 1;
});
