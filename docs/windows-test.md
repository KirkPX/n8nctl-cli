# Real Windows test

A person runs this before the first release, and again after a change to sign-in, install or storage. CI cannot show whether a browser opens or what a new user sees.

Steps: install from the README in a normal PowerShell window; open a new window and run `n8nctl --version` and `n8nctl doctor`; sign in with `n8nctl login` and with `--paste`; confirm the key is in Credential Manager; run one list command at the terminal and piped to a file; read a file from a path with a space and a non-English character; try `--dry-run` and `--read-only`; press Ctrl-C at a prompt; uninstall and remove the saved key.

| Date | Version | Windows | Node | Result | Problems |
|---|---|---|---|---|---|
