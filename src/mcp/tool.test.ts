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

  it("mcp_call execute returns aborted text when the runner aborts", async () => {
    const abortedRunner = {
      ...runner,
      callTool: async () => ({ kind: "aborted" as const, text: "MCP call aborted." }),
    } as unknown as McpRunner;
    const tools = createMcpTools(abortedRunner);
    const callTool = tools.find((t) => t.name === "mcp_call")!;
    const result = await executeTool(callTool, "tc-4", { server: "x", tool: "y" });
    expect(result.content).toEqual([{ type: "text", text: "MCP call aborted." }]);
    expect(result.details).toBe("MCP call aborted.");
  });

  it("mcp_call execute returns timed_out text when the runner times out", async () => {
    const timedRunner = {
      ...runner,
      callTool: async () => ({ kind: "timed_out" as const, text: "MCP call timed out after 120000ms." }),
    } as unknown as McpRunner;
    const tools = createMcpTools(timedRunner);
    const callTool = tools.find((t) => t.name === "mcp_call")!;
    const result = await executeTool(callTool, "tc-5", { server: "x", tool: "y" });
    expect(result.content).toEqual([{ type: "text", text: "MCP call timed out after 120000ms." }]);
    expect(result.details).toBe("MCP call timed out after 120000ms.");
  });

  it("mcp_call execute passes non-object args through to the runner, which coerces to {}", async () => {
    // The tool layer does not narrow `args` itself; it passes the value through
    // to McpRunner.callTool, whose coerceArgs coerces non-objects to {}. The
    // fake runner below mirrors that coercion so we assert the execute path
    // completes (does not throw) and the coerced value reaches the runner.
    function coerceArgs(value: unknown): Record<string, unknown> {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const proto = Object.getPrototypeOf(value);
        if (proto === Object.prototype || proto === null) return value as Record<string, unknown>;
      }
      return {};
    }
    const coercingRunner = {
      ...runner,
      callTool: async (_server: string, _tool: string, args: unknown) => ({
        kind: "ok" as const,
        text: `args=${JSON.stringify(coerceArgs(args))}`,
      }),
    } as unknown as McpRunner;
    const tools = createMcpTools(coercingRunner);
    const callTool = tools.find((t) => t.name === "mcp_call")!;

    const arrayResult = await executeTool(callTool, "tc-arr", { server: "x", tool: "y", args: ["not", "an", "object"] });
    expect(arrayResult.content).toEqual([{ type: "text", text: "args={}" }]);

    const stringResult = await executeTool(callTool, "tc-str", { server: "x", tool: "y", args: "string" });
    expect(stringResult.content).toEqual([{ type: "text", text: "args={}" }]);

    const omittedResult = await executeTool(callTool, "tc-omit", { server: "x", tool: "y" });
    expect(omittedResult.content).toEqual([{ type: "text", text: "args={}" }]);

    const objectResult = await executeTool(callTool, "tc-obj", { server: "x", tool: "y", args: { query: "hi" } });
    expect(objectResult.content).toEqual([{ type: "text", text: 'args={"query":"hi"}' }]);
  });

  it("mcp_describe execute returns schema text", async () => {
    const tools = createMcpTools(runner);
    const describeTool = tools.find((t) => t.name === "mcp_describe")!;
    const result = await executeTool(describeTool, "tc-3", { server: "tavily", tool: "tavily_search" });
    expect(result.content).toEqual([{ type: "text", text: "schema for tavily.tavily_search" }]);
    expect(result.details).toBe("schema for tavily.tavily_search");
  });
});
