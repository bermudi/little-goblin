import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { atomicWrite } from "../fs.ts";
import type { ExternalAgentEvent, ExternalAgentRunRecord, InternalRun } from "./types.ts";
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
    return raw as ExternalAgentRunRecord;
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
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (line.length === 0) continue;
      const lineBytes = Buffer.byteLength(line + "\n", "utf-8");
      if (bytes + lineBytes > MAX_EVENT_BYTES) break;
      kept.unshift(line);
      bytes += lineBytes;
    }

    const tmp = join(tmpdir(), `.external-events-${run.id}-${randomBytes(4).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, kept.map((line) => line + "\n").join(""), "utf-8");
      renameSync(tmp, path);
    } catch {
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }

    run.eventsBytes = bytes;
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

  writeResult(runId: string, text: string): void {
    atomicWrite(externalAgentResultPath(this.home, runId), text);
  }

  getResult(runId: string): string {
    const path = externalAgentResultPath(this.home, runId);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  }
}
