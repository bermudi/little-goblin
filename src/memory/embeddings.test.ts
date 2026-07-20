import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { MemoryDatabase } from "./db.ts";
import { EmbeddingProvider } from "./embeddings.ts";

const originalFetch = globalThis.fetch;

function successFetch() {
  return mock(async (_input: string | URL | Request, init?: RequestInit) => {
    const raw = init?.body ? String(init.body) : "{}";
    const body = JSON.parse(raw) as { input?: unknown; model?: string };
    const texts = Array.isArray(body.input) ? (body.input as string[]) : [];
    const data = texts.map((_text, i) => ({
      object: "embedding" as const,
      index: i,
      embedding: [i + 1, i + 2, i + 3],
    }));
    return new Response(
      JSON.stringify({
        object: "list",
        data,
        model: body.model ?? "test-model",
        usage: { total_tokens: 0 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

describe("EmbeddingProvider", () => {
  let db: MemoryDatabase;
  let provider: EmbeddingProvider;
  let originalApiKey: string | undefined;
  let originalModel: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.GOBLIN_MEMORY_EMBEDDING_API_KEY;
    originalModel = process.env.GOBLIN_MEMORY_EMBEDDING_MODEL;
    process.env.GOBLIN_MEMORY_EMBEDDING_API_KEY = "test-api-key";
    process.env.GOBLIN_MEMORY_EMBEDDING_MODEL = "test-model";

    db = new MemoryDatabase(":memory:");
    provider = new EmbeddingProvider(db);

    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;

    if (originalApiKey === undefined) {
      delete process.env.GOBLIN_MEMORY_EMBEDDING_API_KEY;
    } else {
      process.env.GOBLIN_MEMORY_EMBEDDING_API_KEY = originalApiKey;
    }

    if (originalModel === undefined) {
      delete process.env.GOBLIN_MEMORY_EMBEDDING_MODEL;
    } else {
      process.env.GOBLIN_MEMORY_EMBEDDING_MODEL = originalModel;
    }

    db.close();
  });

  it("status() reports the model and is not degraded initially", () => {
    const status = provider.status();
    expect(status.model).toBe("test-model");
    expect(status.degraded).toBe(false);
    expect(status.lastError).toBeUndefined();
  });

  it("embedBatch with fresh text calls fetch and returns embeddings", async () => {
    const fetchMock = successFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await provider.embedBatch(["hello world"]);

    expect(fetchMock.mock.calls.length).toBe(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit | undefined];
    expect(String(url)).toMatch(/\/v1\/embeddings$/);
    const body = JSON.parse(init?.body ? String(init.body) : "{}") as { input: string[]; model: string };
    expect(body.input).toEqual(["hello world"]);
    expect(body.model).toBe("test-model");

    const result = out[0]!;
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.embedding).toBeInstanceOf(Float32Array);
    expect(result.embedding?.length).toBe(3);
    expect(result.embedding).toEqual(new Float32Array([1, 2, 3]));
  });

  it("embedBatch caches results so a second identical call does not fetch", async () => {
    const fetchMock = successFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = await provider.embedBatch(["hello world"]);
    expect(fetchMock.mock.calls.length).toBe(1);
    const firstResult = first[0]!;

    const second = await provider.embedBatch(["hello world"]);
    expect(fetchMock.mock.calls.length).toBe(1);
    const secondResult = second[0]!;
    expect(secondResult.hash).toBe(firstResult.hash);
    expect(secondResult.embedding).toEqual(firstResult.embedding);
  });

  it("reindexIfNeeded with no entries completes without fetch", async () => {
    const fetchMock = successFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await provider.reindexIfNeeded();

    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("setting a different model via env triggers reindex if entries exist", async () => {
    const insertEntry = db.database.query(
      "INSERT INTO memory_entries (id, scope, entry_kind, text, created_at, updated_at, origin) VALUES ($id, $scope, $kind, $text, $created, $updated, $origin)",
    );
    insertEntry.run({
      $id: "entry-1",
      $scope: "general",
      $kind: "memory",
      $text: "hello world",
      $created: 1,
      $updated: 1,
      $origin: "user",
    });
    db.setMeta("embedding_model", "old-model");
    db.setMeta("embedding_provider", "openai");

    const fetchMock = successFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    process.env.GOBLIN_MEMORY_EMBEDDING_MODEL = "new-model";
    const newProvider = new EmbeddingProvider(db);
    await newProvider.reindexIfNeeded();

    expect(fetchMock.mock.calls.length).toBe(1);
    const row = db.database
      .query<{ model: string }, { $entryId: string }>("SELECT model FROM memory_embeddings WHERE entry_id = $entryId")
      .get({ $entryId: "entry-1" });
    expect(row?.model).toBe("new-model");
    expect(db.getMeta("embedding_model")).toBe("new-model");
    expect(db.getMeta("embedding_provider")).toBe("openai");
    expect(db.getMeta("reindexing")).toBe("false");
  });

  it("a non-ok fetch response marks the provider degraded", async () => {
    globalThis.fetch = mock(async () => new Response("Internal Server Error", { status: 500 })) as unknown as typeof fetch;

    const out = await provider.embedBatch(["hello world"]);

    expect(out[0]!.embedding).toBeNull();
    expect(provider.status().degraded).toBe(true);
    expect(provider.status().lastError).toContain("500");
  });
});
