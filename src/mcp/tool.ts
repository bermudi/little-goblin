import { Type, type Static } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpRunner } from "./runner.ts";

const mcpCallSchema = Type.Object({
  server: Type.String(),
  tool: Type.String(),
  args: Type.Optional(Type.Object({}, { additionalProperties: true })),
});

type McpCallInput = Static<typeof mcpCallSchema>;

const mcpDescribeSchema = Type.Object({
  server: Type.String(),
  tool: Type.String(),
});

type McpDescribeInput = Static<typeof mcpDescribeSchema>;

export function createMcpTools(runner: McpRunner): ToolDefinition[] {
  return [
    defineTool({
      name: "mcp_call",
      label: "MCP Call",
      description: buildCallDescription(runner),
      promptSnippet: "mcp_call: invoke a tool on an MCP server (tavily, grep, deepwiki, …).",
      promptGuidelines: [
        "Use `mcp_call` to invoke a tool on an MCP server. The catalog of available servers and tools is in this tool's description.",
        "If you are unsure of a tool's parameters, call `mcp_describe` first to see its schema.",
        "If a call returns an error, the server may be offline or the tool name may have changed. Call `mcp_describe` to see the current surface.",
      ],
      parameters: mcpCallSchema,
      async execute(_toolCallId: string, params: McpCallInput, signal?: AbortSignal) {
        const result = await runner.callTool(params.server, params.tool, params.args, signal);
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: result.text,
        };
      },
    }),
    defineTool({
      name: "mcp_describe",
      label: "MCP Describe",
      description: "Fetch the JSON inputSchema for an MCP tool on a server. Use this when you are unsure what parameters a tool accepts. Returns a pretty-printed JSON schema.",
      promptSnippet: "mcp_describe: fetch the parameter schema for an MCP tool.",
      promptGuidelines: [],
      parameters: mcpDescribeSchema,
      async execute(_toolCallId: string, params: McpDescribeInput, signal?: AbortSignal) {
        const text = await runner.describeTool(params.server, params.tool, signal);
        return {
          content: [{ type: "text" as const, text }],
          details: text,
        };
      },
    }),
  ];
}

function buildCallDescription(runner: McpRunner): string {
  return `Invoke a tool on an MCP server.

${runner.buildCatalogText()}

Use ".server.tool" syntax in your head, but pass ".server" and ".tool" separately.
If you are unsure of a tool's parameters, call mcp_describe first.`;
}
