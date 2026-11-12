# Security policy

Report a vulnerability privately through
[GitHub's security advisory form](https://github.com/KirkPX/n8nctl-cli/security/advisories/new).
Do not open a public issue. Only the latest release is supported.

## How the CLI handles your API key and password

- `n8nctl login` saves the key to the OS keychain. `n8nctl login --email` saves your n8n
  password there too, only after n8n accepts it. `n8nctl logout` removes both.
- Where the keychain is closed, such as over SSH on macOS, the key goes to a
  credentials file in the settings folder. On macOS and Linux only you can read
  that file (mode 600, in a folder with mode 700). On Windows it relies on your
  profile folder's permissions.
- `N8NCTL_API_KEY` takes the key from the environment and stores nothing.
- The key and password are sent only to the n8n address you signed in to. Requests that n8n
  answers with a redirect are not followed, so they cannot carry the key elsewhere.
- `trigger` calls a workflow's public webhook and sends no key or password.
- Error messages and logs redact the key and the editor session.
- The sign-in page listens on `127.0.0.1` only, and accepts a token only with a
  one-time value that it issues itself.

The settings file never holds a key or password.

## Secrets inside workflows

People sometimes type keys and passwords into node parameters or Code nodes. `get`,
`download` and `backup` replace those with `REDACTED_` placeholders before anything is
printed or written, and `upload` refuses a file that still holds a placeholder. The
removal works by pattern, so it can miss a secret in an unusual form: check a backup
before you make it public. Credentials kept in n8n's own credential store are never part
of a workflow, and n8nctl never reads them.

`get --keep-secrets` and `list --full --keep-secrets` are the only ways to see workflows with
their typed-in secrets. Each prints a warning, and neither writes a file.
