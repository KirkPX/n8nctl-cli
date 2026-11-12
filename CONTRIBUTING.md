# Contributing

```bash
npm ci            # installs and builds
npm test          # builds, then runs all tests
npm run typecheck
npm run dev -- --help
```

CI runs these on macOS, Windows and Linux. A change merges only when all of them pass.

## Rules for commands

Read [docs/cross-platform.md](docs/cross-platform.md) first. The short version:

- **Writes:** every command that changes data calls `assertWritable(opts)` first,
  and supports `--dry-run` or asks for confirmation. A destructive command declares
  `--yes` and says `(destructive)` in its description, so
  `tests/command-wiring.test.ts` can check it.
- **Output:** `resolveFormat()` decides the format. Never hard-code it. A command
  writes to stdout once, through `r.result()`. A command that fails leaves stdout empty.
- **Options:** declare every option the handler reads on that subcommand. `--json`
  is declared once, on the root.
- **Testing options:** drive the built CLI, as `tests/command-wiring.test.ts` does.
  A unit test with a literal options object cannot see a missing declaration.
- **Site-specific values:** IDs, names and prefixes belong in the settings file,
  never in the code. See [docs/configuration.md](docs/configuration.md).
- **Number options:** use a parser from `src/cli/parse.ts`. It refuses anything that is
  not a whole number.
- **JSON options:** read them with `readJsonBody()` in `src/cli/read-file.ts`, so they also
  take a file or standard input. PowerShell breaks JSON typed on the command line.
- **Prompts:** ask through `src/cli/ask.ts`, so Ctrl-C exits 130 and restores typing.
- **Errors:** throw the types in `src/errors.ts`, with a hint that gives the next step.
- **Network:** every request has an explicit timeout. Retries are limited, and never
  repeat an unsafe write. The client refuses a request to any host but the signed-in
  service. Get a client from `createClient()`, so retries show at a terminal.
- **Tests:** they mock the service, and `tests/setup.ts` refuses any call to another
  machine. They run with a throwaway home folder (`vitest.config.ts`), and
  `tests/isolation.test.ts` proves it. Never point a test at a real home folder or key.
- **Secrets:** never in repo files or in the settings file.
- **Paths:** no home-folder paths in tracked files. `tests/public.test.ts` checks this.
