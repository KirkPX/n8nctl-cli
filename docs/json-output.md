# JSON output

Every command prints JSON when its output goes to a file or another program, or when you
pass `--json`. This page lists the fields scripts can rely on. A field listed here keeps
its name and meaning within a major version. New fields can appear at any time, so read
the fields you need and ignore the rest.

A command that fails prints nothing on stdout. It prints one JSON object on stderr and
exits with code 1:

```json
{ "error": true, "message": "what went wrong", "hint": "what to do next" }
```

`hint` is there when there is a next step. When n8n refused the request, `message` holds
n8n's own reason.

## backup

`n8nctl backup <folder>` prints one object. `tests/commands.test.ts` checks these field
names, so a change here fails the tests.

| Field | Meaning |
|---|---|
| `schemaVersion` | `1`. Raised when a field below changes meaning or goes away |
| `dir` | The folder, as a full path |
| `index` | The full path of `index.json` |
| `startedAt`, `completedAt` | ISO 8601 times |
| `complete` | `true` when every workflow was saved. Exit code 1 when `false` |
| `counts` | `workflows`, `active`, `inactive`, `archived`, `saved`, `changed`, `failed` |
| `workflows` | A list, one per saved workflow: `id`, `name`, `file` (full path), `active`, `archived`, `updatedAt` (n8n's, or `null`), `contentHash`, `changed` (`true` when the file's content changed) |
| `failures` | A list, one per workflow that could not be saved: `id`, `name`, `error` |
| `staleFiles` | A list of files in the folder that no current workflow writes: `file`, `id` (from the file name, or `null`), `reason` (`not-on-server` or `renamed`). They are kept |

`active` counts workflows that are on and not archived; `inactive` counts those that are
off and not archived.

The folder then holds:

- one `<name>_<id>.json` per workflow, in saved form: secrets replaced by `REDACTED_`
  placeholders, fields that change on every run removed, keys in order, two-space indent.
  `_backup_metadata` holds `workflow_id`, `content_hash` and `server_updated_at`. An
  unchanged workflow gives a byte-identical file, and the file is not rewritten.
- `index.json`: `lastUpdated`, and `workflows`, keyed by ID, each with `name`, `filename`,
  `active`, `archived`, `serverUpdatedAt` and `lastBackupAt`.
- `publish_history/<id>.json` for each workflow n8n has a publish history for. Entries are
  added and never removed.

`backup` never deletes, commits or pushes anything.

## list

An array, one object per workflow: `id`, `name`, `active`, `archived`, `tags` (names),
`nodeCount` (or `null` with `--local`), `createdAt`, `updatedAt`, `file` (the saved file's
path with `--local`, otherwise `null`). With `--full`, each row also has `workflow`: the whole
workflow in saved form, from the same one or two requests. n8n's list answer holds less
about who the workflow is shared with than a single read, so `shared`, and with it
`_backup_metadata.content_hash`, can differ from the file `backup` writes. Every other field is
the same. With `--full --keep-secrets`, `workflow` is each workflow exactly as n8n sends it,
secrets included, for a check that must see them.

## Commands that change things

`upload`, `activate`, `deactivate`, `archive`, `unarchive`, `delete`, `trigger`, `run`,
`retry` and the `tags` commands print one object:

| Field | Meaning |
|---|---|
| `ok` | `false` when anything failed or was refused. Exit code 1 then |
| `dryRun` | `true` for `--dry-run`: nothing was sent |
| `changed` | `true` when something in n8n changed. Always `false` on a dry run |
| `summary` | One line for people |
| `counts` | `total`, `succeeded`, `failed`, for commands that take several workflows |
| `results[]` | One per file or workflow |

`upload` results: `file`, `id`, `name`, `action`, `activated`, `errors[]`, `warnings[]`,
`message`. `action` is one of `created`, `updated`, `would-create`, `would-update`,
`blocked` (a check failed), `exists` (needs `--force`) or `failed`.

`activate`, `deactivate`, `archive` and `unarchive` results: `id`, `name`, `input` (what
you typed), `outcome` (`changed`, `would-change`, `unchanged` or `failed`) and `message`.

`trigger` adds `workflowId`, `method`, `path`, `node`, `status` (the webhook's HTTP
status), `response` (its body) and, with `--wait`, `execution`. `run` and `retry` add
`executionId` and, with `--wait`, `execution`.

A refused confirmation, such as `delete` without `--yes` when nobody can answer, prints
`aborted: true` and a `hint`.

## validate

`files[]`, one per file: `file`, `id`, `name`, `valid`, `errors[]`, `warnings[]`, and
`contentHash` (the hash `backup` would record for it, or `null` when the file is not a
workflow). And
`counts`: `total`, `passed`, `failed`. Exit code 1 when any file fails.

## diff

`id`, `name`, `file`, `hasDifferences`, `counts` (`nodes`, `connections`, `topLevel`,
`danger`, `warn`), `nodeDiffs[]`, `connectionsDiffer`, `topLevelDiffs[]`,
`dualStructureIssues[]`. Each change has `path`, `localValue`, `serverValue` and `severity`:
`danger` for an ID that other things link to, `warn` for a type, version or name, `info`
otherwise. Exit code 1 when `hasDifferences` is `true`.

## Others

- `get`: the workflow, in saved form. With `--keep-secrets`, the workflow exactly as n8n
  sends it.
- `download`: `dir`, `saved[]` (`id`, `name`, `file`), `failed[]` (`workflow`, `error`).
- `executions`: an array of runs as n8n gives them, each with at least `id`, `workflowId`,
  `status`, `mode`, `startedAt`, `stoppedAt`.
- `credentials`: an array: `id`, `name`, `type`, `workflows[]` (`id`, `name`, `active`,
  `archived`, `nodes[]`).
- `nodes`: an array: `type`, `nodes`, `workflows`, `activeWorkflows`.
- `tags list`: an array: `id`, `name`, `workflows`, `activeWorkflows`.
- `static-data`: `id`, `name`, `key`, `value`.
