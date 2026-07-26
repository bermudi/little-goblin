/**
 * Pi infrastructure services and pi-specific filesystem paths.
 *
 * Both `AgentRunner` and `SubagentRunner` import from here, eliminating the
 * cross-module import from `subagents/` into `agent/paths.ts`.
 */

import { readdirSync, statSync, existsSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Pi service factory
// ---------------------------------------------------------------------------

/**
 * The pi services shared across agent runners and subagents.
 *
 * `modelRuntime` is the canonical async auth/model facade (pi-coding-agent
 * 0.80.8+). It supersedes the old `AuthStorage` + `ModelRegistry` pair: a
 * single `ModelRuntime` owns credential resolution (auth.json) and the model
 * catalog (models.json), and is exactly what `createAgentSession` expects.
 */
export interface PiServices {
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
}

/**
 * Construct pi's infrastructure services with paths under `$GOBLIN_HOME/state/pi/`.
 *
 * Stateless — returns new instances on every call. Caching is the caller's
 * responsibility.
 */
export async function createPiServices(home: string): Promise<PiServices> {
  const dir = piAgentDir(home);
  // `allowModelNetwork: false` keeps session init offline: model auth/catalog
  // come from the built-in catalog + models.json, never a network refresh.
  // This matches the pre-0.80.8 `AuthStorage`/`ModelRegistry` behaviour and
  // avoids `ModelRuntime.create` blocking on a ~15s catalog refresh when the
  // network is slow or `PI_OFFLINE` is unset. Live catalog refresh (if wanted)
  // is a separate, on-demand concern (`/model`), not session startup.
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    allowModelNetwork: false,
  });
  const settingsManager = SettingsManager.inMemory({});
  return { modelRuntime, settingsManager };
}

// ---------------------------------------------------------------------------
// Pi-specific path helpers
// ---------------------------------------------------------------------------

/** Path to the pi directory for pi-ai configuration (auth.json, models.json). */
export function piAgentDir(home: string): string {
  return join(home, "state", "pi");
}

export class IncompatiblePiHistoryError extends Error {
  readonly code = "INCOMPATIBLE_PI_HISTORY";
  constructor(
    public readonly filePath: string,
    public readonly headerCwd: string,
    public readonly expectedCwd: string,
  ) {
    super(
      `Incompatible pi history: ${filePath} recorded cwd ${headerCwd} does not match environment cwd ${expectedCwd}`,
    );
    this.name = "IncompatiblePiHistoryError";
  }
}

export class MalformedPiHistoryError extends Error {
  readonly code = "MALFORMED_PI_HISTORY";
  constructor(public readonly filePath: string) {
    super(`Malformed pi history header: ${filePath}`);
    this.name = "MalformedPiHistoryError";
  }
}

/**
 * Return the filesystem canonical form of a cwd for comparison.
 * Falls back to an absolute path if realpath fails.
 */
function canonicalCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

/** Read the first line of a file into a string. */
function readFirstLineSync(filePath: string): string {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const bytesRead = readSync(fd, buffer, 0, 4096, 0);
    const chunk = buffer.toString("utf-8", 0, bytesRead);
    const nl = chunk.indexOf("\n");
    if (nl >= 0) return chunk.slice(0, nl);
    // First line exceeds 4KB or file has no newline: read the whole file.
    const full = new Uint8Array(statSync(filePath).size);
    readSync(fd, full, 0, full.length, 0);
    const fullText = new TextDecoder().decode(full);
    return fullText.split("\n")[0] ?? fullText;
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the session header from a pi JSONL history file and return its cwd.
 * Throws `MalformedPiHistoryError` if the first line cannot be parsed or has
 * no valid `cwd`.
 */
export function readPiSessionHeader(filePath: string): { cwd: string } {
  let firstLine: string;
  try {
    firstLine = readFirstLineSync(filePath);
  } catch (err) {
    throw new MalformedPiHistoryError(filePath);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    throw new MalformedPiHistoryError(filePath);
  }
  if (parsed === null || typeof parsed !== "object" || typeof (parsed as Record<string, unknown>).cwd !== "string") {
    throw new MalformedPiHistoryError(filePath);
  }
  return { cwd: (parsed as Record<string, unknown>).cwd as string };
}

interface PiSessionFile {
  path: string;
  mtime: number;
}

function listPiSessionFiles(piSessionDir: string): PiSessionFile[] {
  if (!existsSync(piSessionDir)) return [];
  let files: string[];
  try {
    files = readdirSync(piSessionDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const entries: PiSessionFile[] = [];
  for (const f of files) {
    const path = join(piSessionDir, f);
    try {
      const mtime = statSync(path).mtime.getTime();
      entries.push({ path, mtime });
    } catch {
      // skip files we cannot stat
    }
  }
  return entries.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Find the most recently modified `.jsonl` session file in `piSessionDir` that
 * is compatible with the runner's expected CWD.
 *
 * A history file is compatible when its header `cwd`, after filesystem
 * canonicalization, equals the runner's expected CWD. The most recent file
 * wins; if it is missing, malformed, or incompatible, initialization fails
 * loudly rather than silently starting empty history. When no history exists,
 * returns null so a new session can be created.
 */
export function findMostRecentCompatiblePiSession(piSessionDir: string, cwd: string): string | null {
  const files = listPiSessionFiles(piSessionDir);
  if (files.length === 0) return null;

  const expected = canonicalCwd(cwd);
  const mostRecent = files[0]!;
  const header = readPiSessionHeader(mostRecent.path);
  const actual = canonicalCwd(header.cwd);
  if (actual !== expected) {
    throw new IncompatiblePiHistoryError(mostRecent.path, header.cwd, cwd);
  }
  return mostRecent.path;
}

/**
 * Validate all `.jsonl` session files in a directory against an expected CWD.
 * Returns an array of incompatible paths. Throws on malformed headers.
 */
export function validatePiSessionHeaders(piSessionDir: string, expectedCwd: string): { path: string; headerCwd: string }[] {
  const files = listPiSessionFiles(piSessionDir);
  const expected = canonicalCwd(expectedCwd);
  const incompatible: { path: string; headerCwd: string }[] = [];
  for (const file of files) {
    const header = readPiSessionHeader(file.path);
    const actual = canonicalCwd(header.cwd);
    if (actual !== expected) {
      incompatible.push({ path: file.path, headerCwd: header.cwd });
    }
  }
  return incompatible;
}
