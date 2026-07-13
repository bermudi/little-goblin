import { join } from "node:path";

export function externalAgentsRoot(home: string): string {
  return join(home, "scratch", "external-agents");
}

export function externalAgentRunDir(home: string, runId: string): string {
  return join(externalAgentsRoot(home), runId);
}

export function externalAgentMetaPath(home: string, runId: string): string {
  return join(externalAgentRunDir(home, runId), "meta.json");
}

export function externalAgentEventsPath(home: string, runId: string): string {
  return join(externalAgentRunDir(home, runId), "events.jsonl");
}

export function externalAgentResultPath(home: string, runId: string): string {
  return join(externalAgentRunDir(home, runId), "result.txt");
}
