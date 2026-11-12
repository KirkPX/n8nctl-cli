# Cross-platform rules

`n8nctl-cli` must work the same on macOS, Windows and Linux. A person on any of them
should be able to install it, run `n8nctl --help`, sign in, and use the same
documented commands.

## Runtime

- Target Node.js 22.18, 24.11 or newer.
- Use TypeScript compiled to ESM JavaScript.
- Do not rely on Bash, Zsh, PowerShell, `sed`, `awk`, `grep`, `curl`, `open`, `osascript`, `xdg-open` or other shell-specific tools for core CLI behavior.
- If a helper must call an external program, first check that the program exists, and return a clear error when it does not.
- Prefer Node APIs over shell commands for filesystem, path, HTTP, browser and process work.

## Paths

- Always use Node's `path`, `fs`, `os` and URL APIs instead of joining strings.
- Never assume `/` as a path separator.
- Never assume where a home folder is. Ask `os.homedir()`.
- Store user settings in the location `src/paths.ts` defines: `%APPDATA%` on Windows, the XDG folder elsewhere.
- Keep project-local `.env` support as a development convenience only, not as the main place for user settings.
- Do not rely on filename case. Linux filesystems are case-sensitive, and macOS and Windows usually are not.

## Files

- Treat filenames as Unicode strings. Read and write text as UTF-8, unless a file format says otherwise.
- Test every command that reads a file with a path that holds spaces and non-English characters.
- A file named by an option is read with `readOptionFile()` in `src/cli/read-file.ts`, so a failure names the option and the file in plain words.
- Write a file that matters to a temporary name beside it, then rename it over the old one, so a crash cannot leave half a file.
- Keep line endings as LF in the repo (`.gitattributes`), so a Windows checkout cannot break the `dist/index.js` first line.

## Secrets

- Do not write API keys or tokens into repo files.
- Support environment variables for CI and automation.
- Store a person's key in the OS keychain: Keychain on macOS, Credential Manager on Windows, Secret Service on Linux.
- When the keychain is closed or missing, use the private credentials file: mode 600, in a folder with mode 700. Tell the user where the key went.
- Error messages must never print a full API key or token.

## Terminal

- Human output should be plain, readable and useful without color.
- Color is optional decoration, never the only signal.
- Do not use terminal control sequences that assume a Unix terminal.
- Detect non-interactive output, and do not show spinners or progress animations there.
- Provide JSON output for commands likely to be scripted.
- Every prompt goes through `src/cli/ask.ts`. Ctrl-C at a prompt exits with code 130 and restores typing. Ctrl-D answers with nothing.
- Exit 0 when the reader closes the pipe early (`n8nctl doctor | head -1`). Do not print a stack trace.
- Keep command names and options lowercase, hyphenated and stable.

## Arguments

- PowerShell strips double quotes inside arguments it passes to a program, so JSON typed on the command line can arrive broken there.
- Any option that takes JSON also accepts `@<path>` or `-` for standard input. Use `readJsonBody()` in `src/cli/read-file.ts`, and show the PowerShell form in the README.
- A number option uses a parser from `src/cli/parse.ts`, so anything that is not a whole number stops the command.

## Windows

- Commands must run in PowerShell and Windows Terminal.
- Do not require WSL, Git Bash, Homebrew or Unix command-line tools.
- npm writes `.cmd` and `.ps1` wrapper scripts on Windows, not symlinks. `doctor` reads these wrappers to confirm the command leads to this package.
- A new PATH reaches only new terminals. Tell the user to open one.
- Avoid packages that need native compilation, unless the package is essential and tested on Windows CI.
- Avoid postinstall scripts.
- Show Windows-specific setup in PowerShell.

## macOS

- Commands must run in Terminal and iTerm without Homebrew-only tools for core behavior.
- Do not depend on AppleScript, `open` or browser automation for core CLI behavior. Opening a browser for sign-in is optional, and `--paste` always works.
- The keychain is closed to SSH sessions: reads come back empty and writes fail. The credential store handles this, and falls back to the private file.

## Linux

- Commands must run in any common shell, with no desktop session.
- Follow `XDG_CONFIG_HOME` for settings.
- A server often has no Secret Service and no `xdg-open`. Neither may stop the CLI: the key goes to the private file, and `login --paste` replaces the browser.
- Do not assume one distribution, one package manager or glibc-only tools.
- The built `dist/index.js` needs its executable bit and its `#!/usr/bin/env node` first line. The build and npm take care of both.

## Packaging

- The package exposes `n8nctl` as its binary.
- Install the release the way a user does, away from the repo, and run it. CI does this on macOS, Windows and Linux with `npm pack` and a global install.
- Runtime dependencies should be pure JavaScript or ship prebuilt binaries for all three platforms. The keychain dependency ships prebuilt binaries, so no one needs a compiler.
- Document how to uninstall, and how to remove saved credentials.
