import { prepareEnv } from "../external-agents/env.ts";

export function prepareMcpEnv(goblinHome: string): Record<string, string> {
  const env = prepareEnv();
  env.GOBLIN_HOME = goblinHome;
  return env;
}
