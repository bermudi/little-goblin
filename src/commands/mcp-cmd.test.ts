import { describe, expect, it } from "bun:test";
import { parseMcpCommand, McpCommandSyntaxError } from "./mcp-cmd.ts";

describe("parseMcpCommand", () => {
  it("parses bare /mcp as inspect", () => {
    expect(parseMcpCommand("/mcp")).toEqual({ kind: "inspect" });
  });

  it("parses /mcp with whitespace as inspect", () => {
    expect(parseMcpCommand("/mcp   ")).toEqual({ kind: "inspect" });
  });

  it("parses refresh", () => {
    expect(parseMcpCommand("/mcp refresh")).toEqual({ kind: "refresh" });
  });

  it("parses enable and disable with a server name", () => {
    expect(parseMcpCommand("/mcp enable tavily")).toEqual({ kind: "enable", server: "tavily" });
    expect(parseMcpCommand("/mcp disable grep")).toEqual({ kind: "disable", server: "grep" });
  });

  it("canonicalizes server names", () => {
    expect(parseMcpCommand("/mcp enable Tavily")).toEqual({ kind: "enable", server: "tavily" });
  });

  it("rejects unknown actions", () => {
    expect(() => parseMcpCommand("/mcp frobnicate")).toThrow(McpCommandSyntaxError);
  });

  it("rejects enable/disable without a server", () => {
    expect(() => parseMcpCommand("/mcp enable")).toThrow(McpCommandSyntaxError);
    expect(() => parseMcpCommand("/mcp disable ")).toThrow(McpCommandSyntaxError);
  });

  it("rejects extra arguments", () => {
    expect(() => parseMcpCommand("/mcp enable tavily extra")).toThrow(McpCommandSyntaxError);
    expect(() => parseMcpCommand("/mcp refresh now")).toThrow(McpCommandSyntaxError);
  });

  it("rejects invalid server names", () => {
    expect(() => parseMcpCommand("/mcp enable 'bad name'")).toThrow(McpCommandSyntaxError);
    expect(() => parseMcpCommand("/mcp enable tavily;rm")).toThrow(McpCommandSyntaxError);
  });
});
