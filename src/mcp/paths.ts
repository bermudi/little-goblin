import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function resolveMcporterConfigPath(
  configPath: string | undefined,
  goblinHome: string,
): string | undefined {
  if (configPath === undefined) {
    return undefined;
  }
  if (configPath.startsWith("~")) {
    return join(homedir(), configPath.slice(1));
  }
  if (isAbsolute(configPath)) {
    return configPath;
  }
  return join(goblinHome, configPath);
}
