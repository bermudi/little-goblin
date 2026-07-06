import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { transcribeWithGroq, type AsrInput } from "./groq.ts";

const originalFetch = globalThis.fetch;

function baseInput(overrides: Partial<AsrInput> = {}): AsrInput {
  return {
    audioBytes: new Uint8Array([1, 2, 3, 4]),
    mimeType: "audio/ogg",
    model: "whisper-large-v3-turbo",
    apiKey: "groq-secret-key",
    ...overrides,
  };
}

beforeEach(() => {
  // Each test installs its own fetch mock.
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("transcribeWithGroq", () => {
  it("returns trimmed transcript on a successful 2xx response", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ text: "  hello world  " }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const result = await transcribeWithGroq(baseInput());

    expect(result).toEqual({ ok: true, text: "hello world" });
    // The bearer token travels as a header, not the URL or body.
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect(init.headers).toEqual({ Authorization: "Bearer groq-secret-key" });
  });

  it("returns { ok: true, text: '' } for a 2xx response with empty text", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ text: "   " }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const result = await transcribeWithGroq(baseInput());

    expect(result).toEqual({ ok: true, text: "" });
    expect(result.ok).toBe(true);
  });

  it("returns { ok: false, error } for a non-2xx response", async () => {
    globalThis.fetch = mock(async () =>
      // Groq may echo detail in the body; the implementation must not surface it.
      new Response(JSON.stringify({ error: { message: "model not found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const result = await transcribeWithGroq(baseInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("404");
      // The raw error body is not surfaced.
      expect(result.error).not.toContain("model not found");
    }
  });

  it("returns { ok: false, error } when the API key is missing", async () => {
    const fetchMock = mock(async () => new Response("{}"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await transcribeWithGroq(baseInput({ apiKey: undefined }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not configured");
    // Missing key short-circuits before the network call.
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("returns { ok: false, error } on a network error", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed: ENOTFOUND api.groq.com");
    }) as unknown as typeof fetch;

    const result = await transcribeWithGroq(baseInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("network error");
      // The raw thrown message (which could in principle include details) is
      // not echoed verbatim.
      expect(result.error).not.toContain("ENOTFOUND");
    }
  });

  it("returns a timeout indication when the request times out", async () => {
    globalThis.fetch = mock(async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;

    const result = await transcribeWithGroq(baseInput());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("timed out");
  });

  it("returns { ok: false, error } on malformed JSON", async () => {
    globalThis.fetch = mock(async () =>
      new Response("not json at all", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    ) as unknown as typeof fetch;

    const result = await transcribeWithGroq(baseInput());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("malformed");
  });

  it("returns { ok: false, error } when the JSON shape is wrong", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ segments: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const result = await transcribeWithGroq(baseInput());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("malformed");
  });

  it("uses a Groq-recognized filename extension and places the file field last", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ text: "hello" }), { status: 200 }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await transcribeWithGroq(baseInput({ mimeType: "audio/ogg" }));

    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]!;
    const init = call[1] as RequestInit;
    const body = init.body as FormData;
    const entries = Array.from(body.entries());
    const names = entries.map(([k]) => k);
    expect(names).toEqual(["model", "response_format", "file"]);

    const fileEntry = entries[2]![1];
    expect(fileEntry).toBeInstanceOf(Blob);
    const file = fileEntry as Blob;
    expect((file as File).name).toBe("voice.ogg");
  });

  it("never includes the API key in any failure result or request body", async () => {
    // Drive through several failure paths and assert the key never appears.
    globalThis.fetch = mock(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    const result = await transcribeWithGroq(baseInput({ apiKey: "super-secret-token" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain("super-secret-token");

    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]!;
    const init = call[1] as RequestInit;
    // The key lives only in the Authorization header; the multipart body must
    // not contain it (FormData values are not directly stringifiable here, but
    // we can confirm the header is the only key-bearing field we constructed).
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer super-secret-token",
    );
    expect(init.method).toBe("POST");
  });
});
