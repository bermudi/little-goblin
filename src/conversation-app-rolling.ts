import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export function makeAppRollDestination(db: Database): (conversationId: string) => string {
	const qDestination = db.query<{ conversation_id: string }, [string, string]>(`
		SELECT CASE WHEN EXISTS (
			SELECT 1 FROM app_rolls WHERE conversation_id = ?
		) THEN (
			SELECT conversation_id FROM app_rolls ORDER BY n DESC LIMIT 1
		) ELSE ? END AS conversation_id
	`);
	return (conversationId) => qDestination.get(conversationId, conversationId)!.conversation_id;
}

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
	qDeleteAppRoll: {
		run(conversationId: string): { changes: number };
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

	function unrollApp(id: string): boolean {
		return queries.qDeleteAppRoll.run(id).changes === 1;
	}

	return { currentAppRoll, rollApp, appRollChain, isAppRoll, unrollApp };
}
