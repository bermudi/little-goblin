import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { atomicWrite } from "../fs.ts";
import type { ExternalAgentBackend, ExternalAgentEvent, ExternalAgentRunRecord, ExternalAgentStatus, InternalRun } from "./types.ts";
import { TerminalStatuses } from "./util.ts";
import { nowIso } from "./util.ts";
import {
  externalAgentEventsPath,
  externalAgentMetaPath,
  externalAgentResultPath,
  externalAgentRunDir,
  externalAgentsRoot,
} from "./paths.ts";

const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_LOOKBACK = 20;

export class ExternalRunStore {
  constructor(private readonly home: string) {}

  create(record: ExternalAgentRunRecord): void {
    const dir = externalAgentRunDir(this.home, record.id);
    mkdirSync(dir, { recursive: true });
    this.save(record);
  }

  save(record: ExternalAgentRunRecord): void {
    atomicWrite(externalAgentMetaPath(this.home, record.id), JSON.stringify(record, null, 2));
  }

  load(runId: string): ExternalAgentRunRecord | null {
    const path = externalAgentMetaPath(this.home, runId);
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (raw === null || typeof raw !== "object") {
      throw new Error(`malformed external agent metadata: ${path}`);
    }
    const record = raw as Record<string, unknown>;
    this.validateRecord(record, path);
    return record as unknown as ExternalAgentRunRecord;
  }

  private validateRecord(record: Record<string, unknown>, path: string): void {
    const backends = new Set<ExternalAgentBackend>(["codex", "claude", "devin"]);
    const adapterKinds = new Set<string>(["native", "pty"]);
    const statuses = new Set<ExternalAgentStatus>([
      "starting",
      "running",
      "input_required",
      ...TerminalStatuses,
    ]);

    const stringFields = ["id", "ownerSessionId", "backend", "projectDir", "status", "createdAt", "updatedAt", "adapterKind"];
    for (const field of stringFields) {
      if (typeof record[field] !== "string") {
        throw new Error(`malformed external agent metadata: ${field} is missing or not a string in ${path}`);
      }
    }

    if (!backends.has(record.backend as ExternalAgentBackend)) {
      throw new Error(`malformed external agent metadata: invalid backend in ${path}`);
    }
    if (!statuses.has(record.status as ExternalAgentStatus)) {
      throw new Error(`malformed external agent metadata: invalid status in ${path}`);
    }
    if (!adapterKinds.has(record.adapterKind as string)) {
      throw new Error(`malformed external agent metadata: invalid adapterKind in ${path}`);
    }
    if (typeof record.eventsTruncated !== "boolean" || typeof record.resultTruncated !== "boolean") {
      throw new Error(`malformed external agent metadata: missing boolean truncation flags in ${path}`);
    }

    const optionalStringFields = ["inputRequired", "terminalError"];
    for (const field of optionalStringFields) {
      if (record[field] !== undefined && typeof record[field] !== "string") {
        throw new Error(`malformed external agent metadata: ${field} is not a string in ${path}`);
      }
    }
  }

  list(): ExternalAgentRunRecord[] {
    const root = externalAgentsRoot(this.home);
    if (!existsSync(root)) return [];
    const entries: ExternalAgentRunRecord[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const meta = externalAgentMetaPath(this.home, entry.name);
      if (!existsSync(meta)) continue;
      try {
        const record = this.load(entry.name);
        if (record) entries.push(record);
      } catch (err) {
        throw new Error(`failed to load external run metadata ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return entries;
  }

  appendEvent(run: InternalRun, event: ExternalAgentEvent): void {
    const path = externalAgentEventsPath(this.home, run.id);
    const line = JSON.stringify(event) + "\n";
    appendFileSync(path, line, "utf-8");

    run.eventsBytes += Buffer.byteLength(line, "utf-8");

    if (run.eventsBytes > MAX_EVENT_BYTES) {
      this.trimEvents(run);
    }
  }

  private trimEvents(run: InternalRun): void {
    const path = externalAgentEventsPath(this.home, run.id);
    if (!existsSync(path)) return;

    const raw = readFileSync(path, "utf-8");
    const lines = raw.split("\n");
    let kept: string[] = [];
    let keptBytes = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (line.length === 0) continue;
      const lineBytes = Buffer.byteLength(line + "\n", "utf-8");
      if (keptBytes + lineBytes > MAX_EVENT_BYTES) break;
      kept.unshift(line);
      keptBytes += lineBytes;
    }

    const truncationEvent: ExternalAgentEvent = {
      type: "truncation",
      at: nowIso(),
      message: "event history truncated",
    };
    const truncationLine = JSON.stringify(truncationEvent) + "\n";
    const truncationBytes = Buffer.byteLength(truncationLine, "utf-8");

    const keptStr = kept.map((line) => line + "\n").join("");
    const includeTruncation = keptBytes + truncationBytes <= MAX_EVENT_BYTES;
    const finalStr = includeTruncation ? keptStr + truncationLine : keptStr;

    // atomicWrite uses a temp file in the same directory, so the rewrite is
    // atomic and does not cross filesystems.
    atomicWrite(path, finalStr);

    run.eventsBytes = keptBytes + (includeTruncation ? truncationBytes : 0);
    run.meta.eventsTruncated = true;
  }

  getEvents(runId: string): ExternalAgentEvent[] {
    const path = externalAgentEventsPath(this.home, runId);
    if (!existsSync(path)) return [];

    const raw = readFileSync(path, "utf-8");
    const lines = raw.split("\n");
    const events: ExternalAgentEvent[] = [];
    for (let i = lines.length - 1; i >= 0 && events.length < MAX_EVENT_LOOKBACK; i--) {
      const line = lines[i]!;
      if (line.length === 0) continue;
      try {
        events.unshift(JSON.parse(line) as ExternalAgentEvent);
      } catch {
        // skip corrupted line
      }
    }
    return events;
  }

  getEventsBytes(runId: string): number {
    const path = externalAgentEventsPath(this.home, runId);
    if (!existsSync(path)) return 0;
    return statSync(path).size;
  }

  writeResult(runId: string, text: string): void {
    atomicWrite(externalAgentResultPath(this.home, runId), text);
  }

  getResult(runId: string): string {
    const path = externalAgentResultPath(this.home, runId);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  }
}
