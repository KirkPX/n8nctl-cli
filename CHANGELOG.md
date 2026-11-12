# Changelog

## 0.1.0

First release.

- Sign in with an n8n API key (`login`, browser or `--paste`), or with your n8n email and
  password (`login --email`) for the three commands the key cannot do.
- Read: `list`, `get`, `download`, `backup`, `diff`, `validate`, `executions`, `execution`,
  `static-data`, `credentials`, `nodes`, `tags list`.
- Change: `upload`, `activate`, `deactivate`, `archive`, `unarchive`, `delete`, `trigger`,
  `run`, `retry`, `tags set`, `tags add`, `tags remove`, `tags delete`. Each refuses in
  read-only mode and takes `--dry-run`.
- Secrets in node parameters are removed before a workflow is printed or saved.
  `get --keep-secrets` and `list --full --keep-secrets` give workflows exactly as n8n sends
  them, for a script that must change and re-upload one, or scan for typed-in keys.
- `list --full` adds each whole workflow to the JSON from the list request alone.
- `delayMs` (or `N8NCTL_DELAY_MS`) spaces requests, for an n8n that falls over under fast calls.
- Stable JSON output for scripts, described in docs/json-output.md.
