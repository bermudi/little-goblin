import { describe, expect, it } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpRunner } from "./runner.ts";
import { createMcpTools } from "./tool.ts";

function makeRunner(catalogText: string, resultText = "ok"): McpRunner {
  return {
    ready: Promise.resolve(),
    buildCatalogText: () => catalogText,
    callTool: async (server: string, tool: string, args: unknown) => ({
      kind: "ok" as const,
      text: `${server}.${tool} ${JSON.stringify(args)} ${resultText}`,
    }),
    describeTool: async (server: string, tool: string) => `schema for ${server}.${tool}`,
    refreshCatalog: async () => {},
  } as unknown as McpRunner;
}

type SimpleExecute = (toolCallId: string, params: unknown) => Promise<{ content: { type: "text"; text: string }[]; details: string }>;

function executeTool(tool: ToolDefinition, toolCallId: string, params: unknown) {
  return (tool.execute as SimpleExecute)(toolCallId, params);
}

describe("createMcpTools", () => {
  const runner = makeRunner("Available MCP servers (use mcp_call to invoke):\n- tavily: tavily_search");

  it("returns mcp_call and mcp_describe in stable order", () => {
    const tools = createMcpTools(runner);
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe("mcp_call");
    expect(tools[1]?.name).toBe("mcp_describe");
  });

  it("embeds the catalog text in the mcp_call description", () => {
    const tools = createMcpTools(runner);
    const callTool = tools.find((t) => t.name === "mcp_call");
    expect(callTool?.description).toContain("Available MCP servers");
    expect(callTool?.description).toContain("tavily_search");
  });

  it("mcp_call execute returns text content", async () => {
    const tools = createMcpTools(runner);
    const callTool = tools.find((t) => t.name === "mcp_call")!;
    const result = await executeTool(callTool, "tc-1", { server: "tavily", tool: "tavily_search", args: { query: "hello" } });
    expect(result.content).toEqual([{ type: "text", text: "tavily.tavily_search {\"query\":\"hello\"} ok" }]);
    expect(result.details).toBe("tavily.tavily_search {\"query\":\"hello\"} ok");
  });

  it("mcp_call execute returns error text when the runner errors", async () => {
    const errorRunner = {
      ...runner,
      callTool: async () => ({ kind: "error" as const, text: "Unknown tool" }),
    } as unknown as McpRunner;
    const tools = createMcpTools(errorRunner);
    const callTool = tools.find((t) => t.name === "mcp_call")!;
    const result = await executeTool(callTool, "tc-2", { server: "x", tool: "y" });
    expect(result.content).toEqual([{ type: "text", text: "Unknown tool" }]);
  });

  it("mcp_describe execute returns schema text", async () => {
    const tools = createMcpTools(runner);
    const describeTool = tools.find((t) => t.name === "mcp_describe")!;
    const result = await executeTool(describeTool, "tc-3", { server: "tavily", tool: "tavily_search" });
    expect(result.content).toEqual([{ type: "text", text: "schema for tavily.tavily_search" }]);
    expect(result.details).toBe("schema for tavily.tavily_search");
  });
});
