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
- Stable JSON output for scripts, described in docs/json-output.md.
