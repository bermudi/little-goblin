export class SubagentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubagentError";
	}
}

