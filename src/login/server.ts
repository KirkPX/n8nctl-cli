import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import pc from "picocolors";
import { LoginError } from "../errors.js";
import { openBrowser } from "./browser.js";
import { loginPage } from "./page.js";

const MAX_BODY_BYTES = 8 * 1024;

export type BrowserLoginOptions<T> = {
  /** Verifies the submitted credential and persists it. Throws to reject it. */
  accept: (credential: string, hint?: string) => Promise<T>;
  timeoutMs?: number;
  /** The n8n address already known, to fill in on the page. */
  baseUrl?: string | null;
};

/**
 * Serve a one-page login on loopback, open it, and wait for a credential.
 *
 * Three properties keep this safe and MUST NOT be relaxed:
 *
 *  1. Bind to 127.0.0.1. A server bound to every interface is reachable from
 *     the network while login is open.
 *  2. Use an ephemeral port. A fixed port is a predictable target.
 *  3. Require a one-time nonce. Without it, any page the user happens to be
 *     visiting can POST a credential of its choosing to the CLI, which then
 *     stores it — the user's CLI ends up acting as somebody else's account.
 *
 * Do not add `Access-Control-Allow-Origin: *`. Same-origin is the point: the
 * only page that should reach /callback is the one this server rendered.
 */
export async function runBrowserLogin<T>(opts: BrowserLoginOptions<T>): Promise<T> {
  const nonce = randomUUID();
  const html = loginPage({ nonce, baseUrl: opts.baseUrl });
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  return await new Promise<T>((resolve, reject) => {
    let settled = false;

    const finish = (outcome: { ok: true; value: T } | { ok: false; error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      server.close();
      // close() stops new connections but leaves established ones, and a live
      // socket keeps Node running. Browsers hold theirs open under keep-alive,
      // so drop them rather than trusting the peer to hang up. The delay lets
      // the final response flush first.
      server.closeIdleConnections();
      const drain = setTimeout(() => server.closeAllConnections(), 300);
      drain.unref();

      if (outcome.ok) resolve(outcome.value);
      else reject(outcome.error);
    };

    const server = createServer(async (req, res) => {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      }

      if (req.method === "POST" && req.url === "/callback") {
        let payload: { credential?: string; hint?: string; nonce?: string };
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          respond(res, 400, { error: "Could not read that request." });
          return;
        }

        // A body of `null`, a number or a list is valid JSON but not a sign-in.
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          respond(res, 400, { error: "Could not read that request." });
          return;
        }

        if (payload.nonce !== nonce) {
          respond(res, 403, {
            error: "This login page has expired. Run `n8nctl login` again.",
          });
          return;
        }

        try {
          const value = await opts.accept(payload.credential ?? "", payload.hint || undefined);
          respond(res, 200, { ok: true, value });
          finish({ ok: true, value });
        } catch (error) {
          // Report and keep listening, so a bad paste can be corrected without
          // restarting the CLI.
          respond(res, 400, { error: describe(error) });
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: new LoginError(
          "Login timed out.",
          "Run `n8nctl login --paste` to enter the credential in the terminal instead."
        ),
      });
    }, timeoutMs);
    timer.unref?.();

    server.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        error: new LoginError(
          `Could not start the local login page: ${error.message}`,
          "Run `n8nctl login --paste` to enter the credential in the terminal instead."
        ),
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const url = `http://127.0.0.1:${port}`;

      if (openBrowser(url)) {
        console.error(`Opened ${pc.cyan(url)} in your browser.`);
      } else {
        console.error(`Open this page to finish signing in: ${pc.cyan(url)}`);
      }
      console.error(pc.dim("Waiting... (Ctrl+C to cancel)"));
    });
  });
}

function describe(error: unknown): string {
  if (error instanceof LoginError) {
    return [error.message, error.hint].filter(Boolean).join(" ");
  }
  return error instanceof Error ? error.message : "That credential was rejected.";
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf-8");
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
