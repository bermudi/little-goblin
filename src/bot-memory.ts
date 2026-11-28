import { join } from "node:path";

export function botMemoryPath(folder: string | null): string | null {
	return folder === null ? null : join(folder, "MEMORY.md");
}
