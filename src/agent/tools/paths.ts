import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

// An existing differently-normalized twin of a path (macOS stores
// filenames NFD; models and terminals usually emit NFC), or null. Shared
// by the file tools so a read, an edit, and a write all land on the same
// file instead of silently forking it under a second spelling.
export function unicodeTwin(abs: string): string | null {
	for (const norm of [abs.normalize("NFC"), abs.normalize("NFD")]) {
		if (norm !== abs && existsSync(norm)) return norm;
	}
	return null;
}
