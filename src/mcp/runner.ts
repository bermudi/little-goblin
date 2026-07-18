import { spawn } from "bun";
import { log } from "../log.ts";
import { resolveMcporterConfigPath } from "./paths.ts";
import { prepareMcpEnv } from "./env.ts";
import type { McpConfig } from "../schema.ts";

interface McpToolEntry {
  name: string;
  description: string;
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface McpToolResult {
  kind: "ok" | "error" | "aborted" | "timed_out";
  text: string;
}

export class McpRunner {
  private readonly configPath: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly maxResultChars: number;
  private readonly enabled: string[] | undefined;
  private readonly goblinHome: string;
  private catalog: Map<string, McpToolEntry[]>;
  ready: Promise<void>;

  constructor(config: McpConfig, goblinHome: string) {
    this.configPath = resolveMcporterConfigPath(config.configPath, goblinHome);
    this.defaultTimeoutMs = config.defaultTimeoutMs;
    this.maxResultChars = config.maxResultChars;
    this.enabled = config.enabled;
    this.goblinHome = goblinHome;
    this.catalog = new Map();
    this.ready = this.discoverCatalog()
      .then((catalog) => {
        this.catalog = catalog;
      })
      .catch((err) => {
        log.warn("MCP catalog discovery failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.catalog = new Map();
      });
  }

  async callTool(server: string, tool: string, args: unknown, signal?: AbortSignal): Promise<McpToolResult> {
    await this.ready;
    let argsJson: string;
    try {
      argsJson = JSON.stringify(coerceArgs(args));
    } catch (err) {
      return { kind: "error", text: `MCP call args serialization failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const result = await this.runMcporter(
      ["call", `${server}.${tool}`, "--args", argsJson, "--output", "json", "--timeout", String(this.defaultTimeoutMs)],
      signal,
    );
    if (result.timedOut) {
      return { kind: "timed_out", text: `MCP call timed out after ${this.defaultTimeoutMs}ms.` };
    }
    if (result.aborted) {
      return { kind: "aborted", text: "MCP call aborted." };
    }
    if (result.exitCode !== 0) {
      const errorText = extractErrorText(result.stdout, result.stderr) || `MCP call failed with exit code ${result.exitCode}`;
      return { kind: "error", text: this.capText(errorText) };
    }
    return { kind: "ok", text: this.normalizeContent(result.stdout) };
  }

  async describeTool(server: string, tool: string, signal?: AbortSignal): Promise<string> {
    await this.ready;
    if (!this.catalog.has(server)) {
      return `${server} not in catalog`;
    }
    const result = await this.runMcporter(
      ["list", server, "--schema", "--json", "--timeout", String(this.defaultTimeoutMs)],
      signal,
    );
    if (result.timedOut) {
      return `MCP describe timed out after ${this.defaultTimeoutMs}ms.`;
    }
    if (result.aborted) {
      return "MCP describe aborted.";
    }
    if (result.exitCode !== 0) {
      return this.capText(result.stderr.trim() || result.stdout.trim() || `MCP describe failed with exit code ${result.exitCode}`);
    }
    try {
      const parsed = JSON.parse(result.stdout);
      const tools = parseSchemaTools(parsed);
      const found = tools.find((t) => t.name === tool);
      if (!found) {
        return `${tool} not found on ${server}`;
      }
      return this.capText(JSON.stringify(found.inputSchema, null, 2));
    } catch (err) {
      return this.capText(`MCP describe parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async refreshCatalog(): Promise<void> {
    this.ready = this.discoverCatalog()
      .then((catalog) => {
        this.catalog = catalog;
      })
      .catch((err) => {
        log.warn("MCP catalog refresh failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.catalog = new Map();
      });
    await this.ready;
  }

  buildCatalogText(): string {
    const lines = ["Available MCP servers (use mcp_call to invoke):"];
    for (const [server, tools] of this.catalog) {
      const names = tools.map((t) => t.name).join(", ");
      lines.push(`- ${server}: ${names}`);
    }
    return lines.join("\n");
  }

  private async discoverCatalog(): Promise<Map<string, McpToolEntry[]>> {
    const result = await this.runMcporter(["list", "--json"]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `mcporter list failed with exit code ${result.exitCode}`);
    }
    try {
      const parsed = JSON.parse(result.stdout);
      return filterCatalog(parseCatalog(parsed), this.enabled);
    } catch (err) {
      throw new Error(`Failed to parse mcporter list output: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runMcporter(args: string[], callerSignal?: AbortSignal): Promise<RunResult> {
    const cmd = ["bunx", "--silent", "mcporter", "--log-level", "error"];
    if (this.configPath) {
      cmd.push("--config", this.configPath);
    }
    cmd.push(...args);

    const controller = new AbortController();
    const cleanup: (() => void)[] = [];

    const outerTimeout = AbortSignal.timeout(this.defaultTimeoutMs + 5000);
    const onTimeout = () => {
      if (!controller.signal.aborted) {
        controller.abort(outerTimeout.reason);
      }
    };
    if (outerTimeout.aborted) {
      onTimeout();
    } else {
      outerTimeout.addEventListener("abort", onTimeout, { once: true });
      cleanup.push(() => outerTimeout.removeEventListener("abort", onTimeout));
    }

    if (callerSignal) {
      const onCaller = () => {
        if (!controller.signal.aborted) {
          controller.abort(callerSignal.reason);
        }
      };
      if (callerSignal.aborted) {
        onCaller();
      } else {
        callerSignal.addEventListener("abort", onCaller, { once: true });
        cleanup.push(() => callerSignal.removeEventListener("abort", onCaller));
      }
    }

    try {
      const proc = spawn({
        cmd,
        env: prepareMcpEnv(this.goblinHome),
        signal: controller.signal,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const timedOut = controller.signal.aborted && isTimeoutReason(controller.signal.reason);
      const aborted = controller.signal.aborted && !timedOut;
      return { exitCode, stdout, stderr, timedOut, aborted };
    } catch (err) {
      const timedOut = controller.signal.aborted && isTimeoutReason(controller.signal.reason);
      return {
        exitCode: -1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        timedOut,
        aborted: controller.signal.aborted && !timedOut,
      };
    } finally {
      for (const fn of cleanup) fn();
    }
  }

  private normalizeContent(stdout: string): string {
    const trimmed = stdout.trim();
    if (!trimmed) return "";
    let text: string;
    try {
      const parsed = JSON.parse(trimmed);
      text = renderParsedContent(parsed);
    } catch {
      text = trimmed;
    }
    return this.capText(text);
  }

  private capText(text: string): string {
    if (text.length <= this.maxResultChars) return text;
    const marker = "… [truncated]";
    const keep = Math.max(0, this.maxResultChars - marker.length);
    return text.slice(0, keep) + marker;
  }
}

function coerceArgs(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      return value as Record<string, unknown>;
    }
  }
  return {};
}

function renderParsedContent(parsed: unknown): string {
  if (typeof parsed === "string") return parsed;
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Array.isArray((parsed as { content?: unknown }).content)
  ) {
    const parts = (parsed as { content: unknown[] }).content;
    return parts.map((part) => renderContentPart(part)).join("\n");
  }
  return JSON.stringify(parsed, null, 2);
}

function renderContentPart(part: unknown): string {
  if (typeof part === "string") return part;
  if (part !== null && typeof part === "object" && !Array.isArray(part)) {
    const p = part as { type?: unknown; text?: unknown; mimeType?: unknown };
    if (p.type === "text" && typeof p.text === "string") return p.text;
    if (p.type === "image" && typeof p.mimeType === "string") return `[image: ${p.mimeType}]`;
  }
  return JSON.stringify(part);
}

function extractErrorText(stdout: string, stderr: string): string | undefined {
  const stderrText = stderr.trim();
  if (stderrText) return stderrText;
  const stdoutText = stdout.trim();
  try {
    const parsed = JSON.parse(stdoutText);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { error?: unknown }).error === "string"
    ) {
      return (parsed as { error: string }).error;
    }
  } catch {}
  return stdoutText || undefined;
}

function isTimeoutReason(reason: unknown): boolean {
  return (
    reason !== null &&
    typeof reason === "object" &&
    "name" in reason &&
    typeof (reason as { name: unknown }).name === "string" &&
    (reason as { name: string }).name === "TimeoutError"
  );
}

function parseCatalog(raw: unknown): Map<string, McpToolEntry[]> {
  const catalog = new Map<string, McpToolEntry[]>();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return catalog;
  }
  const asRecord = raw as Record<string, unknown>;

  if (Array.isArray(asRecord.servers)) {
    for (const server of asRecord.servers) {
      if (server !== null && typeof server === "object" && !Array.isArray(server)) {
        const s = server as { name?: unknown; tools?: unknown };
        if (typeof s.name === "string" && Array.isArray(s.tools)) {
          catalog.set(s.name, parseToolEntries(s.tools));
        }
      }
    }
  } else {
    for (const [serverName, tools] of Object.entries(asRecord)) {
      if (Array.isArray(tools)) {
        catalog.set(serverName, parseToolEntries(tools));
      }
    }
  }
  return catalog;
}

function filterCatalog(catalog: Map<string, McpToolEntry[]>, enabled: string[] | undefined): Map<string, McpToolEntry[]> {
  if (!enabled) return catalog;
  const filtered = new Map<string, McpToolEntry[]>();
  for (const name of enabled) {
    const tools = catalog.get(name);
    if (tools) {
      filtered.set(name, tools);
    } else {
      log.warn("MCP enabled server not found in catalog", { server: name });
    }
  }
  return filtered;
}

function parseToolEntries(tools: unknown[]): McpToolEntry[] {
  const entries: McpToolEntry[] = [];
  for (const tool of tools) {
    if (tool !== null && typeof tool === "object" && !Array.isArray(tool)) {
      const t = tool as { name?: unknown; description?: unknown };
      if (typeof t.name === "string" && typeof t.description === "string") {
        entries.push({ name: t.name, description: t.description });
      }
    }
  }
  return entries;
}

interface SchemaTool {
  name: string;
  inputSchema: unknown;
}

function parseSchemaTools(raw: unknown): SchemaTool[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const asRecord = raw as Record<string, unknown>;
  if (!Array.isArray(asRecord.tools)) return [];
  const tools: SchemaTool[] = [];
  for (const tool of asRecord.tools) {
    if (tool !== null && typeof tool === "object" && !Array.isArray(tool)) {
      const t = tool as { name?: unknown; inputSchema?: unknown };
      if (typeof t.name === "string") {
        tools.push({ name: t.name, inputSchema: t.inputSchema });
      }
    }
  }
  return tools;
}
