import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { findOpener, openBrowser, openerArgument } from "../src/login/browser.js";
import { loginPage } from "../src/login/page.js";
import { runBrowserLogin } from "../src/login/server.js";

describe("login page", () => {
  it("embeds the nonce so only this page can post back", () => {
    expect(loginPage({ nonce: "abc-123" })).toContain('"abc-123"');
  });

  it("loads no external scripts", () => {
    // A page that collects a credential must not also load third-party code.
    expect(loginPage({ nonce: "n" })).not.toMatch(/<script[^>]+src=/i);
  });
});

describe("findOpener", () => {
  // An explicit existence probe, so each platform branch can be asserted from
  // any platform. Probing the real filesystem makes the macOS case fail on a
  // Windows runner — a test that asserts the host, not the code.
  const present = () => true;
  const absent = () => false;

  it("uses cmd's empty-title form on Windows", () => {
    expect(findOpener("win32", { ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" })).toEqual({
      command: "C:\\WINDOWS\\system32\\cmd.exe",
      args: ["/c", "start", ""],
    });
  });

  it("passes an empty string, not two quote characters, as the title", () => {
    // Node renders an empty argument as "" on Windows. A literal '""' would be
    // escaped to "\"\"" and reach cmd as a real title, swallowing the URL.
    expect(findOpener("win32", {})!.args[2]).toBe("");
  });

  it("uses /usr/bin/open on macOS", () => {
    expect(findOpener("darwin", {}, present)).toEqual({
      command: "/usr/bin/open",
      args: [],
    });
  });

  it("uses xdg-open from PATH on Linux", () => {
    expect(findOpener("linux", { PATH: "/usr/bin" }, present)).toEqual({
      command: path.join("/usr/bin", "xdg-open"),
      args: [],
    });
  });

  it("returns null when no opener exists", () => {
    expect(findOpener("darwin", {}, absent)).toBeNull();
    expect(findOpener("linux", { PATH: "/nowhere" }, absent)).toBeNull();
  });
});

describe("openerArgument", () => {
  const url = "http://127.0.0.1:5000/?nonce=a&site=b";

  it("escapes cmd's special characters on Windows, so the whole URL reaches the browser", () => {
    expect(openerArgument(url, "win32")).toBe("http://127.0.0.1:5000/?nonce=a^&site=b");
    expect(openerArgument("a|b<c>d^e", "win32")).toBe("a^|b^<c^>d^^e");
  });

  it("leaves the URL alone elsewhere", () => {
    expect(openerArgument(url, "darwin")).toBe(url);
    expect(openerArgument(url, "linux")).toBe(url);
  });
});

describe("openBrowser", () => {
  it("launches nothing when the no-browser guard is set", () => {
    // vitest.config.ts sets this for the whole suite.
    expect(openBrowser("http://127.0.0.1:9/never")).toBe(false);
  });
});

describe("runBrowserLogin", () => {
  // Without this, the next test's spy still holds the old server's URL.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Reads the served page's nonce, then posts like the browser would. */
  async function drive(accept: (c: string) => Promise<unknown>) {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pending = runBrowserLogin({ accept: accept as never, timeoutMs: 10_000 });

    let base = "";
    for (let i = 0; i < 200 && !base; i++) {
      const match = /(http:\/\/127\.0\.0\.1:\d+)/.exec(logSpy.mock.calls.flat().join(" "));
      if (match) base = match[1]!;
      else await new Promise((r) => setTimeout(r, 10));
    }
    if (!base) throw new Error("server never reported a URL");

    const html = await (await fetch(base)).text();
    const nonce = /var NONCE = "([^"]+)"/.exec(html)![1]!;
    return { pending, base, nonce };
  }

  const post = (base: string, body: unknown) =>
    fetch(`${base}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("binds to loopback on an ephemeral port", async () => {
    const { pending, base, nonce } = await drive(async () => ({ ok: true }));
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(base).not.toContain(":0");
    await post(base, { credential: "c", nonce });
    await pending;
  });

  it("refuses a post that does not carry the page's nonce", async () => {
    const accept = vi.fn().mockResolvedValue({ ok: true });
    const { pending, base, nonce } = await drive(accept as never);

    // This is the attack the nonce exists to stop: any other page the user has
    // open posting a credential of its choosing into the CLI.
    const forged = await post(base, { credential: "attacker", nonce: "wrong" });
    expect(forged.status).toBe(403);
    expect(accept).not.toHaveBeenCalled();

    const real = await post(base, { credential: "c", nonce });
    expect(real.status).toBe(200);
    await pending;
  });

  it("answers 400 to a body that is valid JSON but not an object, and keeps listening", async () => {
    const accept = vi.fn().mockResolvedValue({ ok: true });
    const { pending, base, nonce } = await drive(accept as never);
    for (const body of [null, 7, ["x"]]) {
      expect((await post(base, body)).status).toBe(400);
    }
    expect(accept).not.toHaveBeenCalled();
    expect((await post(base, { credential: "c", nonce })).status).toBe(200);
    await pending;
  });

  it("keeps listening after a rejected credential so the user can retry", async () => {
    const accept = vi
      .fn()
      .mockRejectedValueOnce(new Error("rejected"))
      .mockResolvedValueOnce({ ok: true });
    const { pending, base, nonce } = await drive(accept as never);

    expect((await post(base, { credential: "bad", nonce })).status).toBe(400);
    expect((await post(base, { credential: "good", nonce })).status).toBe(200);
    await pending;
  });
});
