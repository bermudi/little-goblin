// Magic-byte image sniffing — the one bytes-level classifier behind
// both consumers: file-side sniffing (tools/read.ts's sniffImage, which
// powers read_file's image note and Telegram's photo-vs-document pick)
// and generated-image naming (agent/image.ts). One core so the
// extension a generated file is saved under can never disagree with the
// media type delivery sniffs back off the same bytes. Only the head is
// read: every format's magic — and its dimensions, where the header
// carries them — lives in the first few KB. JPEG needs the headroom:
// APP0/EXIF/DQT segments routinely push the SOF frame past 64 bytes.

/** How much of the head the classifier needs — file-side callers read
 *  exactly this window. */
export const SNIFF_HEAD = 4096;

export interface SniffedImage {
	mediaType: string;
	/** Filename suffix matching the sniffed container ("png", "jpg", …). */
	ext: string;
	width?: number;
	height?: number;
}

export function sniffImageBytes(bytes: Uint8Array): SniffedImage | null {
	const head = bytes.subarray(0, SNIFF_HEAD);
	const b = Buffer.isBuffer(head) ? head : Buffer.from(head);
	// PNG: 8-byte signature, then the IHDR chunk — dims at 16/20,
	// big-endian. A head too short for IHDR still names the type.
	if (
		b.length >= 8 &&
		b[0] === 0x89 &&
		b[1] === 0x50 &&
		b[2] === 0x4e &&
		b[3] === 0x47 &&
		b[4] === 0x0d &&
		b[5] === 0x0a &&
		b[6] === 0x1a &&
		b[7] === 0x0a
	) {
		return {
			mediaType: "image/png",
			ext: "png",
			...(b.length >= 24
				? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
				: {}),
		};
	}
	// JPEG: walk start-of-frame markers; SOF0/1/2 carry 16-bit dims.
	if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
		let i = 2;
		while (i + 9 < b.length) {
			if (b[i] !== 0xff) {
				i++;
				continue;
			}
			const marker = b[i + 1]!;
			// SOF0..SOF15, excluding DAC (C4), JPG (C8), RST segments.
			if (
				marker >= 0xc0 &&
				marker <= 0xcf &&
				marker !== 0xc4 &&
				marker !== 0xc8 &&
				marker !== 0xcc
			) {
				return {
					mediaType: "image/jpeg",
					ext: "jpg",
					height: b.readUInt16BE(i + 5),
					width: b.readUInt16BE(i + 7),
				};
			}
			// Skip this segment by its length; stop if it runs past the window.
			if (i + 3 >= b.length) break;
			i += 2 + b.readUInt16BE(i + 2);
		}
		return { mediaType: "image/jpeg", ext: "jpg" };
	}
	// GIF: magic "GIF8", little-endian dims at offset 6.
	if (b.length >= 10 && b.subarray(0, 4).toString("latin1") === "GIF8") {
		return {
			mediaType: "image/gif",
			ext: "gif",
			width: b.readUInt16LE(6),
			height: b.readUInt16LE(8),
		};
	}
	// BMP: "BM", little-endian dims at offset 18.
	if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
		return {
			mediaType: "image/bmp",
			ext: "bmp",
			width: b.readInt32LE(18),
			height: b.readInt32LE(22),
		};
	}
	// WEBP: RIFF container with WEBP fourcc — dims live deeper in the
	// chunk stream, mediaType only.
	if (
		b.length >= 12 &&
		b.subarray(0, 4).toString("latin1") === "RIFF" &&
		b.subarray(8, 12).toString("latin1") === "WEBP"
	) {
		return { mediaType: "image/webp", ext: "webp" };
	}
	return null;
}
