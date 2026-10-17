import { appIdSchema } from "../conversation.ts";

export const NO_STORE = { "cache-control": "no-store" };

// Conversation id path segment: the minted id alone (the "app/" prefix
// can't appear inside a path segment, so the full id is rebuilt here).
export function conversationFromSegment(segment: string): { id: string } | Response {
	let decoded: string;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		decoded = "";
	}
	const parsed = appIdSchema.safeParse(decoded);
	if (!parsed.success) {
		return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
	}
	return { id: `app/${parsed.data}` };
}
