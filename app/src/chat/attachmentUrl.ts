const INLINE_IMAGE =
	/^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/;
const INLINE_AUDIO = /^audio\//;

export async function fetchAttachmentUrl(
	token: string | null,
	path: string,
): Promise<string> {
	const name = path.split("/").pop() ?? "";
	const res = await fetch(`/api/app/attachments/${encodeURIComponent(name)}`, {
		headers: token === null ? {} : { authorization: `Bearer ${token}` },
	});
	if (!res.ok) throw new Error(`http ${res.status}`);
	const bytes = await res.blob();
	if (INLINE_IMAGE.test(bytes.type) || INLINE_AUDIO.test(bytes.type)) {
		return URL.createObjectURL(bytes);
	}
	return URL.createObjectURL(
		new Blob([bytes], { type: "application/octet-stream" }),
	);
}
