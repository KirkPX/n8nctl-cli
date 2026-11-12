// Runs before every test file. It stops the run when a test could reach the real
// home folder or the real keychain, and it refuses network calls to any other
// machine. Do not remove a check to make a test pass: fix vitest.config.ts or the test.

import { homedir, tmpdir } from "node:os";
import path from "node:path";

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

if (!isInside(tmpdir(), homedir())) {
  throw new Error(
    `Tests must use a throwaway home folder, but the home folder is ${homedir()}. ` +
      "Run them through `npm test`, and keep HOME and USERPROFILE in vitest.config.ts."
  );
}
if (process.env.N8NCTL_CLI_CREDENTIAL_STORE !== "memory") {
  throw new Error("Tests must use the memory credential store. See vitest.config.ts.");
}
if (!process.env.N8NCTL_CLI_NO_BROWSER) {
  throw new Error("Tests must not open a browser. See vitest.config.ts.");
}

// Assigned directly, not with vi.stubGlobal: vi.unstubAllGlobals() in a test would
// restore the real fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const address = input instanceof Request ? input.url : String(input);
  const { hostname } = new URL(address);
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    throw new Error(`A test tried to call a real service: ${hostname}. Mock fetch instead.`);
  }
  return realFetch(input, init);
};
