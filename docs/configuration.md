# Configuration

Most people need no configuration: `n8nctl login` saves your n8n address and stores your
key. The settings file is for behavior you want every time.

## Where it lives

Run `n8nctl config path` to see it.

| Platform | Location |
|---|---|
| macOS, Linux | `$XDG_CONFIG_HOME/n8nctl-cli/config.json`, or `~/.config/n8nctl-cli/config.json` |
| Windows | `%APPDATA%\n8nctl-cli\config.json` |

`N8NCTL_CLI_CONFIG_FILE` points the CLI at another file. Use it to keep one
file per environment, or to commit a shared file to a team's own repo.

## Precedence

Highest first: command flags, environment variables, the settings file (and the
keychain for the key), defaults.

## Settings

See [examples/config.json](../examples/config.json) for a full file.

| Key | Type | Default | What it does |
|---|---|---|---|
| `baseUrl` | URL | none | The n8n address, such as `https://n8n.example.com`. `login` sets it. |
| `email` | email | none | Your n8n email, for `archive`, `unarchive` and `run`. `login --email` sets it. |
| `account` | text | `default` | Which saved sign-in to use. |
| `accounts.<name>.baseUrl` | URL | `baseUrl` | The address for one named sign-in, when you use more than one n8n. |
| `accounts.<name>.email` | email | `email` | The email for one named sign-in. |
| `readOnly` | boolean | `false` | Refuse every command that changes data. |
| `timeoutMs` | integer, up to 600000 | `30000` | How long to wait for each request. Reading a page of full workflows always gets at least 60 seconds. |
| `delayMs` | integer, up to 60000 | `0` | Wait this long between requests. Set it for an n8n that falls over under fast calls. `N8NCTL_DELAY_MS` overrides it; `backup --delay` overrides both. |
| `workflowsDir` | folder | `workflows` | Where `download`, `backup`, `diff` and `list --local` keep files, relative to where you run the command. |

The file never holds your API key or password.

Change a setting with a command, so you never edit or copy the file by hand:

```bash
n8nctl config set readOnly true
n8nctl config set accounts.staging.baseUrl https://n8n-staging.example.com
n8nctl config unset readOnly
```

## Validation

`n8nctl config show` checks the file and prints it. Every command that reads the
file checks it first, and stops with the reason if it is wrong. It stops on an
unknown key too: if `readonly` were ignored as a typo, commands would write when you
meant to block them. `n8nctl doctor` reports a bad file without stopping.

A missing file is fine. It means no settings.

## Read-only mode

The `--read-only` flag always turns it on. `N8NCTL_READ_ONLY` beats the settings
file in both directions, so `N8NCTL_READ_ONLY=0` lets one run write when the file
says `"readOnly": true`.

## Where the key is stored

`n8nctl login` tries the OS keychain first, and reads the key back to confirm it
was saved. `n8nctl login --email` keeps your n8n password the same way, next to the key. When the keychain is closed, the key goes to `credentials.json` in the same
folder as the settings file. Only you can read that file on macOS and Linux. When that
file already exists and a new key goes to the keychain, the file is updated too, so
sessions that cannot reach the keychain do not keep using the old key.

| Variable | What it does |
|---|---|
| `N8NCTL_API_KEY` | Use this key and store nothing. |
| `N8NCTL_PASSWORD` | Use this n8n password for `archive`, `unarchive` and `run`, and store nothing. |
| `N8NCTL_CLI_CREDENTIALS_FILE` | Keep the credentials file somewhere else. |
| `N8NCTL_CLI_CREDENTIAL_STORE` | `file` always uses the file. `memory` keeps the key for one process only. |
