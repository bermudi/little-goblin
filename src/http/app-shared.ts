// Shared plumbing for the app channel's route modules: the no-store
// header every JSON response carries, and the JSON-body CSRF backstop.

export const NO_STORE = { "cache-control": "no-store" };

// JSON-body mutations must say what they are (#75): application/json
// is beyond a no-cors form or fetch (those carry text/plain,
// urlencoded, or multipart), so the claim itself is a CSRF backstop
// behind the origin gate. Applies in both auth modes — wire contract,
// not trust. Multipart uploads and bodyless routes (stop, delete)
// never read JSON and never see this check.
export function jsonBodyRefusal(req: Request): Response | null {
	const mediaType = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (mediaType === "application/json") return null;
	return Response.json({ error: "expected application/json" }, { status: 415, headers: NO_STORE });
}
