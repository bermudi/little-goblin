import { describe, expect, test } from "bun:test";
import { sniffImageBytes } from "./sniff.ts";

// The one classifier both consumers share — file-side sniffing
// (read_file, Telegram delivery) and generated-image naming. Pins the
// coverage table so a container added for one consumer can't drift from
// the other.

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("sniffImageBytes", () => {
	test("png names dims from IHDR; a short head still names the type", () => {
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(50, 0);
		ihdr.writeUInt32BE(30, 4);
		const png = Buffer.concat([
			Buffer.from(PNG_SIG),
			Buffer.from([0, 0, 0, 13]),
			Buffer.from("IHDR"),
			ihdr,
			Buffer.alloc(4),
		]);
		expect(sniffImageBytes(png)).toEqual({
			mediaType: "image/png",
			ext: "png",
			width: 50,
			height: 30,
		});
		// Signature only — dims are a bonus, never a gate.
		expect(sniffImageBytes(new Uint8Array(PNG_SIG))?.mediaType).toBe("image/png");
	});

	test("jpeg walks to SOF for dims; no SOF in the window still names the type", () => {
		const sof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x1e, 0x00, 0x32, 0x00]);
		expect(sniffImageBytes(sof)).toEqual({
			mediaType: "image/jpeg",
			ext: "jpg",
			width: 50,
			height: 30,
		});
		expect(sniffImageBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe1]))).toEqual({
			mediaType: "image/jpeg",
			ext: "jpg",
		});
	});

	test("gif, bmp, webp name ext — dims where the header carries them", () => {
		const gif = Buffer.alloc(10);
		gif.write("GIF89a", 0, "latin1");
		gif.writeUInt16LE(20, 6);
		gif.writeUInt16LE(10, 8);
		expect(sniffImageBytes(gif)).toEqual({
			mediaType: "image/gif",
			ext: "gif",
			width: 20,
			height: 10,
		});
		const bmp = Buffer.alloc(26);
		bmp.write("BM", 0, "latin1");
		bmp.writeInt32LE(40, 18);
		bmp.writeInt32LE(30, 22);
		expect(sniffImageBytes(bmp)).toEqual({
			mediaType: "image/bmp",
			ext: "bmp",
			width: 40,
			height: 30,
		});
		const webp = Buffer.alloc(12);
		webp.write("RIFF", 0, "latin1");
		webp.write("WEBP", 8, "latin1");
		expect(sniffImageBytes(webp)).toEqual({ mediaType: "image/webp", ext: "webp" });
	});

	test("unrecognized bytes return null; non-Buffer views classify the same", () => {
		expect(sniffImageBytes(Buffer.from("not an image"))).toBeNull();
		expect(sniffImageBytes(new Uint8Array([1, 2, 3]))).toBeNull();
		expect(sniffImageBytes(new Uint8Array(PNG_SIG))?.ext).toBe("png");
	});
});
