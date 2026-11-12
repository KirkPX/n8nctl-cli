import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/cli/client-helpers.js";
import { ApiClient, buildUrl, isRetryable } from "../src/client.js";
import { ApiError, NetworkError, TimeoutError } from "../src/errors.js";

const BASE = "https://api.example.com/v1";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeClient(extra: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}): ApiClient {
  return new ApiClient({ baseUrl: BASE, apiKey: "secret-key", retryBaseDelayMs: 0, ...extra });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildUrl keeps requests on the signed-in service", () => {
  it("keeps a path under the base URL", () => {
    expect(buildUrl(BASE, "/me", { page: 2 })).toBe("https://api.example.com/v1/me?page=2");
    expect(buildUrl(BASE, "me")).toBe("https://api.example.com/v1/me");
    expect(buildUrl(`${BASE}/`, "/me")).toBe("https://api.example.com/v1/me");
  });

  it("accepts a full address on the same service", () => {
    expect(buildUrl(BASE, "https://api.example.com/files/1")).toBe("https://api.example.com/files/1");
  });

  it.each([
    "//other.example/x",
    "/\\other.example/x",
    "\t//other.example/x",
    "https://other.example/x",
    "http://api.example.com/x",
    "https://api.example.com.other.example/x",
    "https://api.example.com:8443/x",
  ])("refuses %j", (path) => {
    expect(() => buildUrl(BASE, path)).toThrow("requests go only to api.example.com");
  });

  it("gives a plain message for a base URL that is not an address", () => {
    expect(() => buildUrl("not a url", "/me")).toThrow('on "not a url"');
  });

  it("refuses before the key is sent anywhere", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(makeClient().request("https://other.example/x")).rejects.toThrow("Refusing");
    await expect(makeClient().request("//other.example/x")).rejects.toThrow("Refusing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the key to the signed-in service", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await makeClient().request("/me");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/me");
    expect(init.headers["X-N8N-API-KEY"]).toBe("secret-key");
    expect(init.headers.Authorization).toBeUndefined();
  });
});

describe("retries", () => {
  it("retry 429 on every method, and 5xx only on GET", () => {
    expect(isRetryable(429, "POST")).toBe(true);
    expect(isRetryable(503, "GET")).toBe(true);
    expect(isRetryable(500, "POST")).toBe(false);
    expect(isRetryable(404, "GET")).toBe(false);
  });

  it("a GET retries a 5xx and tells onRetry", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({}, 503)).mockResolvedValue(json({ ok: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const onRetry = vi.fn();
    await expect(makeClient({ onRetry }).request("/me")).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ status: 503, attempt: 1 }));
  });

  it("a POST does not retry a 5xx: the write may already have applied", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({}, 500));
    vi.stubGlobal("fetch", fetchMock);
    await expect(makeClient().request("/items", { method: "POST", body: {} })).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stops after maxRetries", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({}, 429));
    vi.stubGlobal("fetch", fetchMock);
    await expect(makeClient({ maxRetries: 2 }).request("/me")).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Retry-After sets the delay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({}, 429, { "retry-after": "0" }))
        .mockResolvedValue(json({}))
    );
    const onRetry = vi.fn();
    await makeClient({ retryBaseDelayMs: 60_000, onRetry }).request("/me");
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 0 }));
  });

  it("createClient shows a retry at a terminal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({}, 429, { "retry-after": "0" }))
        .mockResolvedValue(json({}))
    );
    vi.stubEnv("N8NCTL_API_KEY", "test-key");
    vi.spyOn(process, "stdout", "get").mockReturnValue({ isTTY: true } as never);
    const note = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createClient({ baseUrl: BASE }).request("/me");

    expect(note).toHaveBeenCalledWith(expect.stringContaining("answered 429 for GET /me"));
    vi.unstubAllEnvs();
  });
});

describe("spacing requests", () => {
  it("sends requests from parallel callers at least minIntervalMs apart", async () => {
    const times: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      times.push(Date.now());
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));
    const client = makeClient({ minIntervalMs: 40 });
    await Promise.all([client.request("/a"), client.request("/b"), client.request("/c")]);
    vi.unstubAllGlobals();
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(35);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(35);
  });
});

describe("failures read as plain messages", () => {
  it("names the host and the reason when the service cannot be reached", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause })));
    const error = await makeClient().request("/me").catch((e) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.message).toBe("GET /me could not reach api.example.com (ENOTFOUND).");
    expect(error.hint).toContain("n8nctl doctor");
    expect(error.message).not.toContain("secret-key");
  });

  it("stops a reply that starts and then stalls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"items":['));
            init.signal?.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError"))
            );
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      })
    );
    await expect(makeClient({ timeoutMs: 50 }).request("/me")).rejects.toBeInstanceOf(TimeoutError);
  });

  it("still reads a reply that is not JSON as no data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{broken", { headers: { "content-type": "application/json" } }))
    );
    await expect(makeClient().request("/me")).resolves.toMatchObject({ status: 200, data: null });
  });
});
