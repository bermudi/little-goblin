import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { FORGET_LISTING_TTL_MS, ForgetListings, renderNumberedListing } from "./forget-listings.ts";

function memdb(): Database {
	return new Database(":memory:");
}

const items = (n: number) =>
	Array.from({ length: n }, (_, i) => ({
		documentId: `exchange/dm:1/${i + 1}/a${i + 1}`,
		preview: `snippet ${i + 1}`,
	}));

describe("ForgetListings", () => {
	test("listings are isolated per conversation", () => {
		const listings = new ForgetListings(memdb());
		listings.save("dm:1", [{ documentId: "exchange/a", preview: "p" }]);
		// B has no row of its own — a number from A's listing must not
		// resolve here (wrong-document deletion is the invariant).
		expect(listings.resolve("dm:2", "1", Date.now())).toBeNull();
	});

	test("save then resolve — 1-based, id and preview round-trip", () => {
		const listings = new ForgetListings(memdb());
		listings.save("c1", items(3));
		const t = Date.now();
		expect(listings.resolve("c1", "1", t)).toEqual({
			documentId: "exchange/dm:1/1/a1",
			preview: "snippet 1",
		});
		expect(listings.resolve("c1", "3", t)?.documentId).toBe("exchange/dm:1/3/a3");
	});

	test("save replaces the previous listing in place", () => {
		const listings = new ForgetListings(memdb());
		listings.save("c1", items(2));
		listings.save("c1", [{ documentId: "exchange/other", preview: "new" }]);
		const t = Date.now();
		expect(listings.resolve("c1", "1", t)?.documentId).toBe("exchange/other");
		expect(listings.resolve("c1", "2", t)).toBeNull();
	});

	test("listings are capped at 20 items", () => {
		const listings = new ForgetListings(memdb());
		listings.save("c1", items(25));
		const t = Date.now();
		expect(listings.resolve("c1", "20", t)?.documentId).toBe("exchange/dm:1/20/a20");
		expect(listings.resolve("c1", "21", t)).toBeNull();
	});

	test("a listing older than the ttl refuses", () => {
		const listings = new ForgetListings(memdb());
		const before = Date.now();
		listings.save("c1", items(1));
		// created_at >= before, so at before+ttl the row is within budget…
		expect(listings.resolve("c1", "1", before + FORGET_LISTING_TTL_MS)).not.toBeNull();
		// …and a comfortable margin past it is expired.
		expect(listings.resolve("c1", "1", before + FORGET_LISTING_TTL_MS + 60_000)).toBeNull();
	});

	test("no cached listing refuses", () => {
		const listings = new ForgetListings(memdb());
		expect(listings.resolve("c1", "1", Date.now())).toBeNull();
	});

	test("out-of-range indexes refuse — 0 and past the end", () => {
		const listings = new ForgetListings(memdb());
		listings.save("c1", items(3));
		const t = Date.now();
		expect(listings.resolve("c1", "0", t)).toBeNull();
		expect(listings.resolve("c1", "4", t)).toBeNull();
	});

	test("non-numeric refs are document ids — resolve returns null", () => {
		const listings = new ForgetListings(memdb());
		listings.save("c1", items(2));
		expect(listings.resolve("c1", "exchange/dm:1/1/a1", Date.now())).toBeNull();
	});

	test("a corrupted JSON row fails closed — null, not a throw", () => {
		const db = memdb();
		const listings = new ForgetListings(db);
		listings.save("c1", items(2));
		db.run("UPDATE forget_listings SET items = '{not json' WHERE conversation_id = 'c1'");
		expect(listings.resolve("c1", "1", Date.now())).toBeNull();
	});

	test("a shape-invalid row fails closed — null, not a throw", () => {
		const db = memdb();
		const listings = new ForgetListings(db);
		listings.save("c1", items(2));
		db.run('UPDATE forget_listings SET items = \'[{"documentId": 7,"preview":"x"}]\' WHERE conversation_id = \'c1\'');
		expect(listings.resolve("c1", "1", Date.now())).toBeNull();
	});

	test("an unparseable created_at fails closed", () => {
		const db = memdb();
		const listings = new ForgetListings(db);
		listings.save("c1", items(2));
		db.run("UPDATE forget_listings SET created_at = 'not-a-date' WHERE conversation_id = 'c1'");
		expect(listings.resolve("c1", "1", Date.now())).toBeNull();
	});
});

describe("renderNumberedListing", () => {
	test("numbered lines with the date fragment when present", () => {
		expect(
			renderNumberedListing([
				{ documentId: "exchange/a", preview: "Lighthouse weekends.", date: "2026-02-01" },
				{ documentId: "exchange/b", preview: "Quiet mornings." },
			]),
		).toBe("1. Lighthouse weekends. (2026-02-01)\n2. Quiet mornings.");
	});

	test("an empty listing renders nothing", () => {
		expect(renderNumberedListing([])).toBe("");
	});
});
