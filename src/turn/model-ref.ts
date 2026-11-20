export function stepModelRef(step: {
	label?: string;
	model?: string | { modelId: string };
}): string {
	if (step.label !== undefined) return step.label;
	const model = step.model;
	if (model !== undefined) return typeof model === "string" ? model : model.modelId;
	throw new Error("step carries no model ref");
}
