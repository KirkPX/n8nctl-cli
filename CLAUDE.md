# Agent instructions

Follow [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/cross-platform.md](docs/cross-platform.md).

Project shape:

- `src/index.ts`: CLI entry point, with lazy command imports and the top-level error handler.
- `src/client.ts`: n8n's public API (`/api/v1`, API key), with timeout, limited retries, redacted errors and a shape check on every answer.
- `src/client-editor.ts`: n8n's editor API (`/rest`, email and password) for archive, unarchive and run, and the public webhook client for trigger. Both reuse `ApiClient.request()`.
- `src/workflow/`: workflow logic with no network: secret removal, the saved form, diff, upload checks, run plans, file reading, and the shape checks for n8n's answers.
- `src/paths.ts`: the settings folder. `src/settings.ts`: the settings file. `src/config.ts`: the precedence chain.
- `src/auth.ts`: credential stores.
- `src/errors.ts`: typed errors, with secret redaction.
- `src/cli/output.ts`, `src/cli/guardrails.ts`: output format, dry runs, confirmation, read-only.
- `src/cli/ask.ts`: every prompt. `src/cli/parse.ts`: number options. `src/cli/read-file.ts`: files and JSON bodies. `src/cli/client-helpers.ts`: `createClient()`.
- `src/cli/commands/`: one file per command group, imported lazily from `index.ts`.
- `src/login/`: the browser sign-in page and the paste fallback.

## Rules that matter most

- **ESM and `tsup`**, Node 22.18, 24.11 or newer. Do not switch to CommonJS or build with plain `tsc`. It leaves old files in `dist/`.
- **Dependencies are fixed:** `commander`, `zod`, `@napi-rs/keyring`, `picocolors`. Do not add `axios`, `chalk`, `inquirer`, `ora` or `jest`. Use `fetch`, `picocolors`, readline and `vitest`.
- **Build without `--dts`.** TypeScript 7 has no compiler API for `tsup --dts`. A CLI needs no type files.
- **`private: true` stays.** Releases are GitHub-only, and this prevents an accidental npm publish.
- **Secrets** go through `src/auth.ts`, or `N8NCTL_API_KEY`. Never print a full token. Use `redact()`.
- **Settings** go through `src/settings.ts` and `src/config.ts`. One precedence chain: flags, env, settings file or keychain, default.

## Adding a command

- **Read command:** copy `src/cli/commands/static-data.ts`. Register it in `index.ts` with a lazy `import()`.
- **Command that changes data:** call `assertWritable(opts)`, then `confirmDestructive(msg, opts)` for destructive actions, and report through `printDryRun()`, so output separates changed, would change and nothing changed.
- Number options use `src/cli/parse.ts`. Options that take JSON use `readJsonBody()` in `src/cli/read-file.ts`.
- Update `README.md` and add a test in the same change. Add every new environment variable to `.env.example`.
- Test a command that changes workflows against `tests/fake-n8n.ts` only. Never against a real n8n.
- A change to JSON that `backup`, `list` or `upload` prints is a change to a contract: update `docs/json-output.md`, and raise `schemaVersion` in `backup` if a field changes meaning or goes away.

## Verify before committing

```bash
npm run typecheck && npm test && npm run build && npm run smoke
```

## n8n facts the code depends on

- The public API takes the key in the `X-N8N-API-KEY` header. It cannot list credentials (GET `/credentials` answers 405), archive a workflow, or run one; it refuses unknown query parameters with 400.
- The editor API (`/rest`) refuses API keys. Sign-in is POST `/rest/login` with `emailOrLdapLoginId` and `password`, and the `n8n-auth` cookie is tied to the `browser-id` header sent with it.
- These were read from n8n 2.x. A new n8n version can change the editor API without notice; the shape checks in `src/workflow/shape.ts` stop a command when an answer changes.
