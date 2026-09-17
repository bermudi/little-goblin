// The four tools. Hand-rolled, zod-validated, bound to the conversation's
// cwd. Telegram send is delivery, not a tool. Nothing else exists until a
// feature needs it.

import type { ToolSet } from "ai";
import { bashTool } from "./bash.ts";
import { editFileTool } from "./edit.ts";
import { readFileTool } from "./read.ts";
import { writeFileTool } from "./write.ts";

export function makeTools(cwd: string): ToolSet {
	return {
		read_file: readFileTool(cwd),
		write_file: writeFileTool(cwd),
		edit_file: editFileTool(cwd),
		bash: bashTool(cwd),
	};
}
