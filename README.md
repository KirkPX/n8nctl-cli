# n8nctl-cli

[![CI](https://github.com/KirkPX/n8nctl-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/KirkPX/n8nctl-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Manage the workflows on a self-hosted or cloud [n8n](https://n8n.io) from the terminal:
list them, back them up to files, compare a file with the live workflow, upload changes,
switch them on and off, and run them.

Runs on macOS, Windows and Linux. Output is readable at a terminal and JSON in a pipe,
every change can be previewed or blocked, and your key stays in the OS keychain.

The command is `n8nctl`, because n8n's own package already installs a command called `n8n`.

## Install

You need **Node.js 22.18, 24.11 or newer** and Git.

```bash
cd ~
git clone https://github.com/KirkPX/n8nctl-cli.git
cd n8nctl-cli
npm run setup
n8nctl login
```

`cd ~` puts the tool in your home folder. A PowerShell window can open in a system folder,
where the clone would fail or be hard to find. To update later:

```bash
cd ~/n8nctl-cli
git pull
npm run setup
```

`npm run setup` installs, builds, links, and then tells you where you stand. If the
`n8nctl` command is not reachable yet, it says so and prints the fix.

On Windows, install Node and Git with `winget install OpenJS.NodeJS.LTS Git.Git`, then use
a **new** PowerShell window, because an open window keeps the old PATH. You need no compiler.

## Sign in

n8n offers two ways in, and n8nctl offers both.

**An API key** is what almost every command uses. Create one in n8n under
**Settings > n8n API**, then:

```bash
n8nctl login            # opens a local page: type your n8n address and paste the key
n8nctl login --paste    # no browser: SSH, a server, a locked-down desktop
```

**Your own n8n email and password** are needed only by `archive`, `unarchive` and `run`.
n8n's API key cannot do those three, so n8nctl does them the way the n8n editor does,
signed in as you:

```bash
n8nctl login --email                     # asks for the email and password
n8nctl login --email --mfa-code 123456   # if your n8n sign-in uses a two-step code
```

If your n8n signs in only through SSO (SAML or OIDC), these three commands are not
available; every other command works with the API key.

Sign-in checks the key or password with n8n before it saves anything. Running `n8nctl`
with no arguments signs you in if you never have, and shows help otherwise.

```bash
n8nctl logout           # removes the saved key and any saved password
```

For CI and agents, where no keychain exists, set the values in the environment:

```bash
export N8NCTL_BASE_URL=https://n8n.example.com
export N8NCTL_API_KEY=<your-key>
```

```powershell
$env:N8NCTL_BASE_URL = "https://n8n.example.com"
$env:N8NCTL_API_KEY = "<your-key>"
```

To use more than one n8n, give each sign-in a name: `n8nctl login --account staging`,
then add `--account staging` to any command.

## Configure

Highest wins:

1. Command flags (for example `--base-url`, `--account`)
2. Environment variables (`N8NCTL_BASE_URL`, `N8NCTL_API_KEY`, `N8NCTL_ACCOUNT`, `N8NCTL_EMAIL`,
   `N8NCTL_PASSWORD`, `N8NCTL_WORKFLOWS_DIR`)
3. The settings file, and the keychain for the key and password
4. Built-in defaults (there is no default n8n address)

```bash
n8nctl config path                                  # where the settings file lives
n8nctl config show                                  # check the file and print it
n8nctl config set baseUrl https://n8n.example.com   # change one setting
n8nctl config set workflowsDir ./workflows          # where workflow files go
n8nctl config set readOnly true                     # block every change
n8nctl config unset readOnly                        # remove a setting
```

See [docs/configuration.md](docs/configuration.md) and [examples/config.json](examples/config.json).

## First command

```bash
n8nctl list                       # every workflow, readable in a terminal
n8nctl list --active --json       # machine-readable
n8nctl list > workflows.json      # JSON when sent to a file or another program, with no flag
```

## Commands

Reading. None of these changes anything in n8n.

| Command | What it does |
|---|---|
| `list` | Workflows on the server. `--active`, `--inactive`, `--archived`, `--exclude-archived`, `--name <text>`, `--tag <name>`. `--local` reads a backup folder instead. `--full` adds each whole workflow to the JSON |
| `get <workflow>` | One workflow as JSON, secrets removed. `--keep-secrets` prints it exactly as n8n sends it, so a script can change it and upload it again |
| `download <workflow...>` / `download --all` | Save workflows as files, secrets removed |
| `backup [folder]` | Save every workflow, archived ones too, plus `index.json` and publish history. Writes files only: it never commits, pushes or deletes |
| `diff <workflow>` | Compare a saved file with the live workflow. Exit code 1 when they differ |
| `validate <file or folder>` | Check files offline with the checks `upload` runs first. Exit code 1 on a failure |
| `executions [workflow]` | Recent runs. `--status error`, `--limit 50` |
| `execution <id>` | One run. `--include-data` adds each node's input and output |
| `static-data <workflow>` | What a workflow remembers between runs. `--key node:Poller` |
| `credentials` | The credentials workflows use, and which workflows use each |
| `nodes` | How often each node type is used |
| `tags list` | Every tag, and how many workflows have it |

A workflow can be named by its ID or its exact name, in any case.

Changing. Every one of these refuses in read-only mode and takes `--dry-run`.

| Command | What it does |
|---|---|
| `upload <file or folder>` | Create or replace workflows. `--force` replaces one that exists; `--activate` switches it on |
| `activate <workflow...>` / `deactivate <workflow...>` | Switch workflows on or off |
| `archive <workflow...>` / `unarchive <workflow...>` | Archive (switching it off first), or restore. Needs `login --email` |
| `delete <workflow>` | Delete for good. Asks first, or takes `--yes` |
| `trigger <workflow>` | Call the workflow's Webhook node, as an outside system would. `--data`, `--wait` |
| `run <workflow>` | Run it as the editor's Execute button does. `--trigger`, `--data`, `--wait`. Needs `login --email` |
| `retry <execution>` | Run a failed execution again with its input. `--latest`, `--wait` |
| `tags set` / `tags add` / `tags remove <workflow> <tags...>` | Change one workflow's tags |
| `tags delete <tags...>` | Delete tags from n8n and every workflow |

`--data` takes JSON, `@file`, or `-` for standard input. PowerShell can break JSON typed on
the command line, so use a file there:

```powershell
n8nctl trigger "Order intake" --data "@order.json"
```

## Output

Every command prints **human-readable** output in a terminal and **JSON** when the output
is piped or redirected, or when you pass `--json`. A command that fails leaves stdout
empty and prints the reason on stderr; when n8n refuses something, its own reason is shown.

The JSON of `backup`, `list`, `upload` and the other commands that scripts read is a stable
contract, described in [docs/json-output.md](docs/json-output.md).

## Safety

Commands that change data:

- refuse to run in read-only mode (`--read-only`, `N8NCTL_READ_ONLY=1`, or `"readOnly": true` in the settings file)
- ask for confirmation before deleting, or take `--yes` to skip the question
- never ask in `--json` or non-interactive mode: pass `--yes`
- support `--dry-run` to run every check and show what would change, without changing anything

`upload` checks each file first. It refuses a file whose nodes lost their IDs, whose links
point at missing nodes, or whose node, webhook or credential IDs differ from the live
workflow, because n8n links those by ID. It also refuses a file that still holds a
`REDACTED_` placeholder: that file came from a download or backup, which remove secrets,
and uploading it would overwrite the real value.

## Troubleshooting

```bash
n8nctl doctor            # install, settings file, credential store, key
npm run doctor           # the same check, when the command itself is not found
```

- **"No n8n address is set"**: run `n8nctl login`, or `n8nctl config set baseUrl <url>`.
- **"Not signed in"**: run `n8nctl login`, or set `N8NCTL_API_KEY`.
- **"n8n refused the API key"**: create a new key in n8n under Settings > n8n API, then run `n8nctl login --force`.
- **"n8n sent the request on to …"**: the address is not the one n8n answers on, for example `http://` where n8n uses `https://`. Set the right one with `n8nctl config set baseUrl <url>`.
- **"needs your own n8n sign-in"**: run `n8nctl login --email`.
- **"n8n answered in a form this version of n8nctl does not know"**: your n8n version changed something n8nctl reads. Update n8nctl.
- **"Invalid settings"**: the settings file has a typo or an unknown key. The message names it.
- **`n8nctl on PATH: shadowed`**: another program of the same name comes first on your PATH.
- **"running scripts is disabled on this system"** (PowerShell): the execution policy blocks npm's `.ps1` launcher. Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## Use it from another project

Each release on GitHub has a ready-built package file. A project that runs n8nctl from its
scripts can depend on that file, so everyone who installs the project gets the same n8nctl:

```json
{
  "dependencies": {
    "n8nctl-cli": "https://github.com/KirkPX/n8nctl-cli/releases/download/v0.1.1/n8nctl-cli-0.1.1.tgz"
  }
}
```

The file holds the built CLI, so it installs with no build step and no install scripts (npm
or pnpm). The command is then `node_modules/.bin/n8nctl`. To move to a new version, change the
version in both places of the address and install again.

## Uninstall

```bash
n8nctl logout            # removes the saved key and password; run this first
npm uninstall -g n8nctl-cli
```

The settings file stays. `n8nctl config path` shows where it is, before you uninstall.
