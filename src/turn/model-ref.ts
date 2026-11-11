// The serving model ref of a turn attempt — the value stamped on the
// landed reply's metadata.model and the reasoning-origin key the model
// view filters by (#417). Leaf module: naming the step types would
// close an import cycle (import-cycles.test.ts counts `import type`
// edges too), so the parameter is structural — label wins, then the
// model's own ref.
export function stepModelRef(step: {
	label?: string;
	model?: string | { modelId: string };
}): string {
	if (step.label !== undefined) return step.label;
	const model = step.model;
	if (model !== undefined) return typeof model === "string" ? model : model.modelId;
	throw new Error("step carries no model ref");
}
