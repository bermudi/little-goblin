import { z } from "zod";
import { inputJsonSchema } from "../tool.ts";
import { isHosted, type Tools } from "../tool.ts";

export const TOOLS_PART = "data-tools";
export const ADDITIONAL_TOOLS_PREFIX = "GOBLIN_ADDITIONAL_TOOLS:";

export interface ToolDeclaration {
	type: "function";
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	strict: boolean;
}

export interface ToolChange {
	added: ToolDeclaration[];
	removed: string[];
}

export const toolDeclarationSchema = z.object({
	type: z.literal("function"),
	name: z.string().min(1),
	description: z.string(),
	parameters: z.record(z.string(), z.unknown()),
	strict: z.boolean(),
}).strict();
export const toolDeclarationsSchema = z.array(toolDeclarationSchema);

export const toolChangeSchema = z.object({
	added: toolDeclarationsSchema,
	removed: z.array(z.string().min(1)),
}).strict();

export function declarationsOf(tools: Tools): ToolDeclaration[] {
	const declarations: ToolDeclaration[] = [];
	for (const [name, tool] of Object.entries(tools)) {
		if (isHosted(tool)) continue;
		declarations.push({
			type: "function",
			name,
			description: tool.description,
			parameters: inputJsonSchema(tool),
			strict: false,
		});
	}
	return declarations;
}

export function foldDeclarations(changes: ToolChange[]): Map<string, ToolDeclaration> {
	const result = new Map<string, ToolDeclaration>();
	for (const change of changes) {
		for (const name of change.removed) result.delete(name);
		for (const declaration of change.added) result.set(declaration.name, declaration);
	}
	return result;
}

export function diffDeclarations(
	previous: Map<string, ToolDeclaration>,
	current: ToolDeclaration[],
): ToolChange | null {
	const next = new Map(current.map((declaration) => [declaration.name, declaration]));
	const added = current.filter((declaration) => {
		const old = previous.get(declaration.name);
		return old === undefined || JSON.stringify(old) !== JSON.stringify(declaration);
	});
	const removed = [...previous.keys()].filter((name) => !next.has(name));
	return added.length === 0 && removed.length === 0 ? null : { added, removed };
}
