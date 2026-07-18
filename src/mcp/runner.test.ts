import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpRunner } from "./runner.ts";
import type { McpConfig } from "../schema.ts";

let tmpDir: string;
let originalPath: string;

const baseConfig: McpConfig = {
  enabled: undefined,
  configPath: undefined,
  defaultTimeoutMs: 120_000,
  maxResultChars: 100,
};

const outputFile = () => join(tmpDir, "mcp-fake-output");
const exitFile = () => join(tmpDir, "mcp-fake-exit");
const stderrFile = () => join(tmpDir, "mcp-fake-stderr");
const sleepFile = () => join(tmpDir, "mcp-fake-sleep");

function removeControlFiles(): void {
  for (const path of [outputFile(), exitFile(), stderrFile(), sleepFile()]) {
    if (existsSync(path)) {
      rmSync(path);
    }
  }
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-runner-"));
  const bunxPath = join(tmpDir, "bunx");
  const script = `#!/usr/bin/env bash
DIR=$(cd "$(dirname "$0")" && pwd)
OUTPUT_FILE="$DIR/mcp-fake-output"
STDERR_FILE="$DIR/mcp-fake-stderr"
EXIT_FILE="$DIR/mcp-fake-exit"
SLEEP_FILE="$DIR/mcp-fake-sleep"

if [ -f "$STDERR_FILE" ]; then
  STDERR=$(cat "$STDERR_FILE")
  if [ -n "$STDERR" ]; then printf '%s\\n' "$STDERR" >&2; fi
fi

if [ -f "$SLEEP_FILE" ]; then
  SLEEP=$(cat "$SLEEP_FILE")
  if [ -n "$SLEEP" ]; then exec sleep "$SLEEP"; fi
fi

if [ -f "$OUTPUT_FILE" ]; then
  cat "$OUTPUT_FILE"
fi

if [ -f "$EXIT_FILE" ]; then
  exit "$(cat "$EXIT_FILE")"
fi

exit 0
`;
  writeFileSync(bunxPath, script, { mode: 0o755 });
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${tmpDir}:${originalPath}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  removeControlFiles();
  writeFileSync(exitFile(), "0");
});

function setOutput(value: string, exit = 0, stderr = "", sleep = ""): void {
  writeFileSync(outputFile(), value);
  writeFileSync(exitFile(), String(exit));
  if (stderr) {
    writeFileSync(stderrFile(), stderr);
  } else if (existsSync(stderrFile())) {
    rmSync(stderrFile());
  }
  if (sleep) {
    writeFileSync(sleepFile(), sleep);
  } else if (existsSync(sleepFile())) {
    rmSync(sleepFile());
  }
}

describe("McpRunner catalog", () => {
  it("builds the catalog from the server-array JSON shape", async () => {
    setOutput(JSON.stringify({
      servers: [
        { name: "tavily", tools: [{ name: "tavily_search", description: "Search" }] },
        { name: "grep", tools: [{ name: "searchGitHub", description: "Grep" }] },
      ],
    }));
    const runner = new McpRunner(baseConfig, "/tmp/goblin");
    await runner.ready;
    expect(runner.buildCatalogText()).toBe(
      "Available MCP servers (use mcp_call to invoke):\n- tavily: tavily_search\n- grep: searchGitHub",
    );
  });

  it("builds the catalog from the server-record JSON shape", async () => {
    setOutput(JSON.stringify({
      tavily: [{ name: "tavily_search", description: "Search" }],
      grep: [{ name: "searchGitHub", description: "Grep" }],
    }));
    const runner = new McpRunner(baseConfig, "/tmp/goblin");
    await runner.ready;
    expect(runner.buildCatalogText()).toContain("- tavily: tavily_search");
    expect(runner.buildCatalogText()).toContain("- grep: searchGitHub");
  });

  it("filters the catalog by enabled servers", async () => {
    setOutput(JSON.stringify({
      servers: [
        { name: "tavily", tools: [{ name: "tavily_search", description: "Search" }] },
        { name: "grep", tools: [{ name: "searchGitHub", description: "Grep" }] },
      ],
    }));
    const runner = new McpRunner({ ...baseConfig, enabled: ["tavily"] }, "/tmp/goblin");
    await runner.ready;
    const text = runner.buildCatalogText();
    expect(text).toContain("tavily: tavily_search");
    expect(text).not.toContain("grep");
  });

  it("construction does not throw when mcporter list fails", async () => {
    setOutput("boom", 1);
    const runner = new McpRunner(baseConfig, "/tmp/goblin");
    await runner.ready;
    expect(runner.buildCatalogText()).toBe("Available MCP servers (use mcp_call to invoke):");
  });

  it("enabled: [] produces an empty catalog", async () => {
    setOutput(JSON.stringify({
      servers: [
        { name: "tavily", tools: [{ name: "tavily_search", description: "Search" }] },
        { name: "grep", tools: [{ name: "searchGitHub", description: "Grep" }] },
      ],
    }));
    const runner = new McpRunner({ ...baseConfig, enabled: [] }, "/tmp/goblin");
    await runner.ready;
    expect(runner.buildCatalogText()).toBe("Available MCP servers (use mcp_call to invoke):");
  });

  it("refreshCatalog replaces the catalog", async () => {
    setOutput(JSON.stringify({
      servers: [{ name: "tavily", tools: [{ name: "tavily_search", description: "Search" }] }],
    }));
    const runner = new McpRunner(baseConfig, "/tmp/goblin");
    await runner.ready;
    expect(runner.buildCatalogText()).toContain("tavily");

    setOutput(JSON.stringify({
      servers: [{ name: "grep", tools: [{ name: "searchGitHub", description: "Grep" }] }],
    }));
    await runner.refreshCatalog();
    const text = runner.buildCatalogText();
    expect(text).toContain("grep");
    expect(text).not.toContain("tavily");
  });
});

describe("McpRunner.callTool", () => {
  it("returns normalized text for a successful call", async () => {
    setOutput(JSON.stringify({
      servers: [{ name: "tavily", tools: [{ name: "tavily_search", description: "Search" }] }],
    }));
    const runner = new McpRunner(baseConfig, "/tmp/goblin");
    await runner.ready;

    setOutput(JSON.stringify({ answer: "hello result" }));
    const result = await runner.callTool("tavily", "tavily_search", { query: "hello" });
    expect(result.kind).toBe("ok");
    expect(result.text).toContain("hello result");
  });

  it("coerces non-object args to an empty object", async () => {
    setOutput(JSON.stringify({
      servers: [{ name: "deepwiki", tools: [{ name: "read_wiki_structure", description: "Read" }] }],
    }));
    const runner = new McpRunner(baseConfig, "/tmp/goblin");
    await runner.ready;

    setOutput("{}");
    await runner.callTool("deepwiki", "read_wiki_structure", null);
    await runner.callTool("deepwiki", "read_wiki_structure", "string");
    await runner.callTool("deepwiki", "read_wiki_structure", ["a"]);
  });

  it("returns an error result for a non-zero exit", async () => {
    setOutput(JSON.stringify({
      servers: [{ name: "tavily", tools: [{ name: "tavily_search", description: "Search" }] }],
    }));
    const runner = new McpRunner(baseConfig, "/tmp/goblin");
    await runner.ready;

    setOutput("", 1, "Unknown tool: foo");
    const result = await runner.callTool("tavily", "tavily_search", {});
    expect(result.kind).toBe("error");
    expect(result.text).toBe("Unknown tool: foo");
  });

  it("returns an aborted result when the caller signal aborts", async () => {
    setOutput(JSON.stringify({
      servers: [{ name: "tavily", tools: [{ name: "tavily_search", description: "Search" }] }],
    }));
    const runner = new McpRunner({ ...baseConfig, defaultTimeoutMs: 60_000 }, "/tmp/goblin");
    await runner.ready;

    setOutput("", 0, "", "60");
    const controller = new AbortController();
    const promise = runner.callTool("tavily", "tavily_search", {}, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    expect(result.kind).toBe("aborted");
    expect(result.text).toBe("MCP call aborted.");
  });

  it("returns a timed_out result when the outer timeout fires", async () => {
    setOutput(JSON.stringify({
      servers: [{ name: "tavily", tools: [{ name: "tavily_search", description: "Search" }] }],
    }));
    const runner = new McpRunner({ ...baseConfig, defaultTimeoutMs: 100 }, "/tmp/goblin");
    await runner.ready;

    setOutput("", 0, "", "60");
    const result = await runner.callTool("tavily", "tavily_search", {});
    expect(result.kind).toBe("timed_out");
    expect(result.text).toBe("MCP call timed out after 100ms.");
  }, 10_000);
});

describe("McpRunner content normalization", () => {
  it("concatenates text content entries", async () => {
    setOutput(JSON.stringify({
      servers: [{ name: "tavily", tools: [{ name: "tavily_search", description: "Search" }] }],
    }));
    const runner = new McpRunner(baseConfig, "/tmp/goblin");
    await runner.ready;

    setOutput(JSON.stringify({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }));
    const result = await runner.callTool("tavily", "tavily_search", {});
    expect(result.text).toBe("a\nb");
  });

  it("renders image content as placeholders", async () => {
    setOutput(JSON.stringify({
      servers: [{ name: "zai-vision", tools: [{ name: "analyze_image", description: "Analyze" }] }],
    }));
    const runner = new McpRunner(baseConfig, "/tmp/goblin");
    await runner.ready;

    setOutput(JSON.stringify({ content: [{ type: "image", data: "...", mimeType: "image/png" }] }));
    const result = await runner.callTool("zai-vision", "analyze_image", {});
    expect(result.text).toBe("[image: image/png]");
  });

  it("truncates long results to maxResultChars with the marker", async () => {
    setOutput(JSON.stringify({
      servers: [{ name: "tavily", tools: [{ name: "tavily_search", description: "Search" }] }],
    }));
    const runner = new McpRunner({ ...baseConfig, maxResultChars: 50 }, "/tmp/goblin");
    await runner.ready;

    setOutput(JSON.stringify({ answer: "a".repeat(200) }));
    const result = await runner.callTool("tavily", "tavily_search", {});
    expect(result.text.length).toBe(50);
    expect(result.text).toEndWith("… [truncated]");
  });
});

describe("McpRunner.describeTool", () => {
  it("returns the pretty-printed inputSchema for a known tool", async () => {
    setOutput(JSON.stringify({
      servers: [{ name: "tavily", tools: [{ name: "tavily_search", description: "Search" }] }],
    }));
    const runner = new McpRunner(baseConfig, "/tmp/goblin");
    await runner.ready;

    setOutput(JSON.stringify({
      name: "tavily",
      tools: [{ name: "tavily_search", inputSchema: { type: "object", properties: { query: { type: "string" } } } }],
    }));
    const text = await runner.describeTool("tavily", "tavily_search");
    expect(text).toContain('"type": "object"');
    expect(text).toContain("query");
  });

  it("returns '<server> not in catalog' for unknown servers", async () => {
    setOutput(JSON.stringify({ servers: [] }));
    const runner = new McpRunner(baseConfig, "/tmp/goblin");
    await runner.ready;
    const text = await runner.describeTool("ghost", "foo");
    expect(text).toBe("ghost not in catalog");
  });

  it("returns '<tool> not found on <server>' for unknown tools", async () => {
    setOutput(JSON.stringify({
      servers: [{ name: "tavily", tools: [{ name: "tavily_search", description: "Search" }] }],
    }));
    const runner = new McpRunner(baseConfig, "/tmp/goblin");
    await runner.ready;

    setOutput(JSON.stringify({
      name: "tavily",
      tools: [{ name: "tavily_search", inputSchema: {} }],
    }));
    const text = await runner.describeTool("tavily", "ghost_tool");
    expect(text).toBe("ghost_tool not found on tavily");
  });
});
