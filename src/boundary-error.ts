export type BoundaryKind = "missing" | "transient" | "fatal";

export class BoundaryError extends Error {
	constructor(
		readonly boundary: string,
		readonly kind: BoundaryKind,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "BoundaryError";
	}
}

export function boundaryKind(err: unknown): BoundaryKind | null {
	return err instanceof BoundaryError ? err.kind : null;
}
