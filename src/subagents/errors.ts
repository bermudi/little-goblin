// Typed refusal for subagent lifecycle and tool entries — callers
// branch on the class, never on message text.

export class SubagentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubagentError";
	}
}
