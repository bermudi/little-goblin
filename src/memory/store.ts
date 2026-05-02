import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { log } from "../log.ts";
import { archiveTopicPath, memoryDir, scopeMemoryPath, userPath } from "./paths.ts";
import { scopeTag, type MemoryScope } from "./scope.ts";

const MEMORY_CAP = 4000;
const USER_CAP = 2000;
const DESCRIPTION_CAP = 200;
const DELIMITER = "\n§\n";

export type StoreResult = { ok: true } | { ok: false; error: string };
export interface ParsedMemory {
  description?: string;
  body: string;
}

export interface MemoryIndex {
  general?: { description?: string };
  topics: Array<{ chatId: number; topicId: number; description?: string }>;
  agents: Array<{ name: string; description?: string }>;
}

type StoreScope = MemoryScope | "user" | "memory";
type MutateAction = "add" | "replace" | "remove" | "rewrite" | "set_description";

function normalizeScope(scope: StoreScope): MemoryScope | "user" {
  return scope === "memory" ? "general" : scope;
}

function pathFor(home: string, scope: MemoryScope | "user"): string {
  return scope === "user" ? userPath(home) : scopeMemoryPath(home, scope);
}

function capFor(scope: MemoryScope | "user"): number {
  return scope === "user" ? USER_CAP : MEMORY_CAP;
}

export class MemoryStore {
  private home: string;

  constructor(goblinHome: string) {
    this.home = goblinHome;
  }

  read(scope: StoreScope): ParsedMemory {
    return parseMemoryFile(this.readRaw(normalizeScope(scope)));
  }

  readBody(scope: StoreScope): string {
    return this.read(scope).body;
  }

  add(scope: StoreScope, content: string): StoreResult {
    return this.mutate(scope, "add", ({ body, description }) => ({
      description,
      body: body.length === 0 ? content : body + DELIMITER + content,
    }));
  }

  replace(scope: StoreScope, oldText: string, content: string): StoreResult {
    return this.mutate(scope, "replace", ({ body, description }) => {
      const match = findUnique(body, oldText);
      if (!match.ok) return match;
      return {
        description,
        body: body.slice(0, match.index) + content + body.slice(match.index + oldText.length),
      };
    });
  }

  remove(scope: StoreScope, oldText: string): StoreResult {
    return this.mutate(scope, "remove", ({ body, description }) => {
      const match = findUnique(body, oldText);
      if (!match.ok) return match;
      return {
        description,
        body: removeEnclosingEntry(body, match.index, oldText.length),
      };
    });
  }

  rewrite(scope: StoreScope, body: string): StoreResult {
    return this.mutate(scope, "rewrite", ({ description }) => ({ description, body }));
  }

  setDescription(scope: StoreScope, description: string): StoreResult {
    if (description.includes("\n")) {
      return { ok: false, error: "description must be a single line" };
    }
    if (description.length > DESCRIPTION_CAP) {
      return {
        ok: false,
        error: `description would be ${description.length} chars (cap ${DESCRIPTION_CAP}, overflow ${description.length - DESCRIPTION_CAP})`,
      };
    }
    return this.mutate(scope, "set_description", ({ body }) => ({
      description: description.length === 0 ? undefined : description,
      body,
    }));
  }

  listIndex(opts: { chatId?: number; includeAgents: boolean }): MemoryIndex {
    const topicsRoot = join(memoryDir(this.home), "topics");
    const agentsRoot = join(memoryDir(this.home), "agents");
    const generalParsed = this.read("general");
    const general = generalParsed.body.length > 0 || generalParsed.description ? generalParsed : undefined;
    const topics: MemoryIndex["topics"] = [];
    const agents: MemoryIndex["agents"] = [];

    if (existsSync(topicsRoot)) {
      for (const chatEntry of readdirSync(topicsRoot, { withFileTypes: true })) {
        if (!chatEntry.isDirectory()) continue;
        const chatId = Number.parseInt(chatEntry.name, 10);
        if (!Number.isFinite(chatId)) continue;
        if (opts.chatId !== undefined && chatId !== opts.chatId) continue;
        const chatDir = join(topicsRoot, chatEntry.name);
        for (const topicEntry of readdirSync(chatDir, { withFileTypes: true })) {
          if (!topicEntry.isDirectory()) continue;
          const topicId = Number.parseInt(topicEntry.name, 10);
          if (!Number.isFinite(topicId)) continue;
          const parsed = this.read({ topic: { chatId, topicId } });
          topics.push({ chatId, topicId, description: parsed.description });
        }
      }
    }

    if (opts.includeAgents && existsSync(agentsRoot)) {
      for (const entry of readdirSync(agentsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const parsed = this.read({ agent: { name: entry.name } });
        agents.push({ name: entry.name, description: parsed.description });
      }
    }

    topics.sort((a, b) => a.chatId - b.chatId || a.topicId - b.topicId);
    agents.sort((a, b) => a.name.localeCompare(b.name));
    return { general, topics, agents };
  }

  archiveOrphan(chatId: number, topicId: number): boolean {
    const source = dirname(scopeMemoryPath(this.home, { topic: { chatId, topicId } }));
    if (!existsSync(source)) return false;
    const dest = archiveTopicPath(this.home, chatId, topicId);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(source, dest);
    this.commitArchive(chatId, topicId);
    return true;
  }

  private mutate(
    inputScope: StoreScope,
    action: MutateAction,
    op: (current: ParsedMemory) => ParsedMemory | StoreResult,
  ): StoreResult {
    const scope = normalizeScope(inputScope);
    const current = this.read(scope);
    const next = op(current);
    if ("ok" in next) return next;
    const overflow = this.checkCap(scope, next.body);
    if (overflow) return overflow;
    this.write(scope, formatMemoryFile(next));
    this.commit(action, scope);
    return { ok: true };
  }

  private readRaw(scope: MemoryScope | "user"): string {
    const path = pathFor(this.home, scope);
    try {
      return readFileSync(path, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw e;
    }
  }

  private checkCap(scope: MemoryScope | "user", body: string): StoreResult | null {
    const cap = capFor(scope);
    if (body.length > cap) {
      return {
        ok: false,
        error: `${scope === "user" ? "user.md" : "memory.md"} would be ${body.length} chars (cap ${cap}, overflow ${body.length - cap}); consolidate before retrying`,
      };
    }
    return null;
  }

  private write(scope: MemoryScope | "user", contents: string): void {
    const finalPath = pathFor(this.home, scope);
    const dir = dirname(finalPath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `.${scope === "user" ? "user" : "memory"}.md.${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(tmpPath, contents, "utf-8");
    renameSync(tmpPath, finalPath);
  }

  private commit(action: MutateAction, scope: MemoryScope | "user"): void {
    const dir = memoryDir(this.home);
    const path = pathFor(this.home, scope);
    const message = `memory: ${action} in ${scopeTag(scope)}`;
    this.commitPaths(message, [relative(dir, path)]);
  }

  private commitArchive(chatId: number, topicId: number): void {
    const tag = `topics/${chatId}/${topicId}`;
    const dir = memoryDir(this.home);
    // The tag is passed (even though not a valid path) so git records the deletion
    // of the source directory. `git add -A -- <pathspec>` needs the old path to
    // track the rename as a delete+add rather than just an add.
    this.commitPaths(`memory: archive orphan ${tag}`, [
      relative(dir, archiveTopicPath(this.home, chatId, topicId)),
      tag,
    ]);
  }

  private commitPaths(message: string, paths: string[]): void {
    const dir = memoryDir(this.home);
    try {
      this.ensureGitRepo(dir);
      runGit(dir, ["add", "-A", "--", ...paths]);
      const result = runGit(dir, ["commit", "-q", "-m", message], {
        allowFailure: true,
      });
      if (result.status !== 0) {
        const out = (result.stdout + result.stderr).toLowerCase();
        if (out.includes("nothing to commit") || out.includes("no changes added")) return;
        log.warn("memory: git commit failed; file persisted without versioning", {
          message,
          status: result.status,
          stderr: result.stderr.trim() || result.stdout.trim(),
        });
      }
    } catch (e) {
      log.warn("memory: git versioning errored; file persisted without versioning", {
        message,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private ensureGitRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    if (existsSync(join(dir, ".git"))) return;
    runGit(dir, ["init", "-q"]);
    runGit(dir, ["config", "user.name", "goblin"]);
    runGit(dir, ["config", "user.email", "goblin@localhost"]);
    runGit(dir, ["config", "commit.gpgSign", "false"]);
  }
}

function parseMemoryFile(raw: string): ParsedMemory {
  if (!raw.startsWith("---\n")) return { body: raw };
  const end = raw.indexOf("\n---\n\n", 4);
  if (end === -1) return { body: raw };
  const header = raw.slice(4, end);
  const lines = header.split("\n");
  if (lines.length !== 1 || !lines[0]!.startsWith("description: ")) {
    return { body: raw };
  }
  const description = lines[0]!.slice("description: ".length);
  const body = raw.slice(end + "\n---\n\n".length);
  return description.length === 0 ? { body } : { description, body };
}

function formatMemoryFile(parsed: ParsedMemory): string {
  if (parsed.description === undefined) return parsed.body;
  return `---\ndescription: ${parsed.description}\n---\n\n${parsed.body}`;
}

function findUnique(
  hay: string,
  needle: string,
): { ok: true; index: number } | { ok: false; error: string } {
  if (needle.length === 0) {
    return { ok: false, error: "old_text must not be empty" };
  }
  const parts = hay.split(needle);
  const count = parts.length - 1;
  if (count === 0) {
    return { ok: false, error: "old_text not found in target" };
  }
  if (count > 1) {
    return {
      ok: false,
      error: `old_text matched ${count} locations; must be unique`,
    };
  }
  return { ok: true, index: parts[0]!.length };
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runGit(
  cwd: string,
  args: string[],
  opts: { allowFailure?: boolean } = {},
): RunResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  const result: RunResult = {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
  if (!opts.allowFailure && result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (status ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function removeEnclosingEntry(current: string, index: number, len: number): string {
  const before = current.lastIndexOf(DELIMITER, index);
  const entryStart = before === -1 ? 0 : before + DELIMITER.length;
  const after = current.indexOf(DELIMITER, index + len);
  const entryEnd = after === -1 ? current.length : after;

  if (before !== -1) {
    return current.slice(0, before) + current.slice(entryEnd);
  }
  if (after !== -1) {
    return current.slice(0, entryStart) + current.slice(after + DELIMITER.length);
  }
  return "";
}
