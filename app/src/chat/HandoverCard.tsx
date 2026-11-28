import type { UIMessage } from "ai";
import { HANDOVER_STOP_PART, handoverCard, handoverStopSchema } from "../../../src/handover-message.ts";
import { OperatorQuestionCard } from "./AskCard.tsx";

export function HandoverCard({ parts, token }: { parts: UIMessage["parts"]; token: string | null }) {
	const card = handoverCard(parts);
	if (card !== null) {
		return (
			<div className="handover-card">
				<div className="handover-label">Handover · {card.from} → {card.to}</div>
				<div className="handover-request">{card.request}</div>
			</div>
		);
	}
	const part = parts.find((part) => part.type === HANDOVER_STOP_PART);
	const stop = handoverStopSchema.safeParse(part !== undefined && "data" in part ? part.data : null);
	if (stop.success) {
		return (
			<div className="handover-pause">
				<OperatorQuestionCard id={stop.data.askId} question={stop.data.question} token={token} label="Handover paused" heading="Handover paused" />
			</div>
		);
	}
	return null;
}
