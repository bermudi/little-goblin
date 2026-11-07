// Plain-words schedule for the operator-facing diff ("Daily 07:00"). Covers
// the shapes programs use in practice; anything else returns null and the
// caller shows the raw cron. Pure, dependency-free (the app imports it).

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const num = /^\d+$/;

function clock(minute: string, hour: string): string | null {
	if (!num.test(minute) || !num.test(hour)) return null;
	const m = Number(minute);
	const h = Number(hour);
	if (m > 59 || h > 23) return null;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function dayName(d: string): string | null {
	if (!num.test(d)) return null;
	const n = Number(d) % 7; // 7 is Sunday too
	return Number(d) > 7 ? null : (DAYS[n] ?? null);
}

function days(dow: string): string | null {
	if (dow === "1-5") return "Weekdays";
	if (dow === "0,6" || dow === "6,0" || dow === "6,7") return "Weekends";
	const parts = dow.split(",").map(dayName);
	if (parts.some((p) => p === null)) return null;
	return `${(parts as string[]).join(", ")}`;
}

/** "Daily 07:00", "Weekdays 06:30", "Mondays 09:00"… or null when the shape is not covered. */
export function cronWords(cron: string): string | null {
	const f = cron.trim().split(/\s+/);
	if (f.length !== 5) return null;
	const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];

	if (mon !== "*") return null;

	const every = /^\*\/(\d+)$/;
	if (hour === "*" && dom === "*" && dow === "*") {
		if (min === "*") return "Every minute";
		const n = every.exec(min);
		if (n) return `Every ${n[1]} minutes`;
		if (num.test(min) && Number(min) <= 59)
			return min === "0" ? "Hourly" : `Hourly at :${min.padStart(2, "0")}`;
		return null;
	}
	if (min === "0" && dom === "*" && dow === "*") {
		const n = every.exec(hour);
		if (n) return `Every ${n[1]} hours`;
	}

	const at = clock(min, hour);
	if (at === null) return null;

	if (dom === "*" && dow === "*") return `Daily ${at}`;
	if (dom === "*") {
		const d = days(dow);
		if (d === null) return null;
		const plural = /^[A-Za-z]+day$/.test(d) ? `${d}s` : d;
		return `${plural} ${at}`;
	}
	if (dow === "*" && num.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) {
		return `Monthly on day ${dom}, ${at}`;
	}
	return null;
}
