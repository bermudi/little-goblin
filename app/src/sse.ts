export function makeSseParser(onData: (data: string) => void): (chunk: Uint8Array) => void {
	const decoder = new TextDecoder();
	let buffer = "";
	return (chunk) => {
		buffer += decoder.decode(chunk, { stream: true });
		const frames = buffer.split("\n\n");
		buffer = frames.pop() ?? "";
		for (const frame of frames) {
			const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
			if (data !== undefined) onData(data);
		}
	};
}
