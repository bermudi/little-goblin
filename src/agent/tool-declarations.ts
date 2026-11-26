import { z } from "zod";
import { inputJsonSchema } from "../tool.ts";
import { isHosted, type Tools } from "../tool.ts";
import type { Message } from "../message.ts";

export const TOOLS_PART = "data-tools";
export const ADDITIONAL_TOOLS_PREFIX = "GOBLIN_ADDITIONAL_TOOLS:";
export const INCREMENTAL_TOOLS_NOTICE =
	"This is an incremental tools update. Previously declared tools remain available unless explicitly marked unavailable. A tool declared again here is available again, and its latest definition replaces the earlier one.";

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

export function toolRemovalNotice(names: readonly string[]): string {
	return `The following tools are no longer available. Do not call them:\n${names.map((name) => `- ${name}`).join("\n")}`;
}

export function isInInputSystem(message: {
	role?: unknown;
	providerOptions?: unknown;
}): boolean {
	if (message.role !== "system") return false;
	const options = message.providerOptions;
	if (typeof options !== "object" || options === null || Array.isArray(options)) return false;
	const codex = (options as Record<string, unknown>).codex;
	return (
		typeof codex === "object" &&
		codex !== null &&
		!Array.isArray(codex) &&
		(codex as Record<string, unknown>).inInput === true
	);
}

export function storedToolChanges(
	entries: { message: Message }[],
	convId: string,
): { messageId: string; change: ToolChange }[] {
	return entries.flatMap(({ message }) =>
		message.parts.flatMap((part) => {
			if (part.type !== TOOLS_PART) return [];
			const parsed = toolChangeSchema.safeParse((part as { data?: unknown }).data);
			if (!parsed.success) {
				throw new Error(`malformed ${TOOLS_PART} part in conversation ${convId}, message ${message.id}`);
			}
			return [{ messageId: message.id, change: parsed.data }];
		}),
	);
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
