import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

interface AppRollQueries {
	qAppRollCurrent: {
		get(): { n: number; conversation_id: string } | null;
	};
	qAppRollChain: {
		all(limit: number): { n: number; conversation_id: string }[];
	};
	qIsAppRoll: {
		get(id: string): { present: number } | null;
	};
	qAppRollHighwater: {
		get(): { n: number } | null;
	};
	qAppRollHighwaterUpsert: {
		run(n: number): unknown;
	};
	qInsertAppRoll: {
		run(n: number, conversationId: string, createdAt: string): unknown;
	};
}

export function makeConversationAppRolling<
	TConversation extends { id: string; createdAt: string },
	TSummary,
	TConfig,
>(
	db: Database,
	queries: AppRollQueries,
	getConversation: (id: string) => TConversation | null,
	resolveApp: (id: string, config: TConfig) => TConversation,
	summarize: (id: string) => TSummary | null,
) {
	function currentAppRoll(): TConversation | null {
		const row = queries.qAppRollCurrent.get();
		if (row === null) return null;
		return getConversation(row.conversation_id);
	}

	function rollApp(config: TConfig): TConversation {
		return db.transaction(() => {
			const last = queries.qAppRollHighwater.get()?.n ?? 0;
			const current = queries.qAppRollCurrent.get()?.n ?? 0;
			const n = Math.max(last, current) + 1;
			const id = randomUUID();
			const conv = resolveApp(id, config);
			queries.qInsertAppRoll.run(n, conv.id, conv.createdAt);
			queries.qAppRollHighwaterUpsert.run(n);
			return conv;
		})();
	}

	function appRollChain(limit: number): TSummary[] {
		const bounded = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
		return queries.qAppRollChain
			.all(bounded)
			.flatMap(({ conversation_id }) => {
				const summary = summarize(conversation_id);
				return summary === null ? [] : [summary];
			});
	}

	function isAppRoll(id: string): boolean {
		return queries.qIsAppRoll.get(id) !== null;
	}

	return { currentAppRoll, rollApp, appRollChain, isAppRoll };
}
