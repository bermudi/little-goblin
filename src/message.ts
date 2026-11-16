// Structural copies of ai@7.0.173 UI-message and model-outcome types.
export type JSONValue =
	| null
	| string
	| number
	| boolean
	| Readonly<JSONObject>
	| readonly JSONValue[];

export type JSONObject = { [key: string]: JSONValue | undefined };
export type ProviderMetadata = Record<string, JSONObject>;

export type FinishReason =
	| "stop"
	| "length"
	| "content-filter"
	| "tool-calls"
	| "error"
	| "interrupted"
	| "other";

export type Usage = {
	inputTokens: number | undefined;
	inputTokenDetails: {
		noCacheTokens: number | undefined;
		cacheReadTokens: number | undefined;
		cacheWriteTokens: number | undefined;
	};
	outputTokens: number | undefined;
	outputTokenDetails: {
		textTokens: number | undefined;
		reasoningTokens: number | undefined;
	};
	totalTokens: number | undefined;
	raw?: JSONObject;
};

type Citation = {
	source:
		| {
				type: "source";
				sourceType: "url";
				id: string;
				url: string;
				title?: string;
				providerMetadata?: ProviderMetadata;
		  }
		| {
				type: "source";
				sourceType: "document";
				id: string;
				mediaType: string;
				title: string;
				filename?: string;
				providerMetadata?: ProviderMetadata;
		  };
	startIndex?: number;
	endIndex?: number;
	citedText?: string;
};

type TextPart = {
	type: "text";
	citations?: Array<Citation>;
	text: string;
	state?: "streaming" | "done";
	providerMetadata?: ProviderMetadata;
};

type FilePart = {
	type: "file";
	mediaType: string;
	filename?: string;
	url: string;
			providerReference?: Record<string, string> & { type?: never };
	providerMetadata?: ProviderMetadata;
};

type ReasoningPart = {
	type: "reasoning";
	id?: string;
	text: string;
	state?: "streaming" | "done";
	providerMetadata?: ProviderMetadata;
};

type ToolInvocation = {
	toolCallId: string;
	title?: string;
	toolMetadata?: JSONObject;
	providerExecuted?: boolean;
} & (
	| {
			state: "input-streaming";
			input?: unknown;
			rawInput?: string;
			inputEncoding?: "json" | "text";
			output?: never;
			errorText?: never;
			callProviderMetadata?: ProviderMetadata;
			approval?: never;
	  }
	| {
			state: "input-available";
			input: unknown;
			output?: never;
			errorText?: never;
			callProviderMetadata?: ProviderMetadata;
			approval?: never;
	  }
	| {
			state: "approval-requested";
			input: unknown;
			output?: never;
			errorText?: never;
			callProviderMetadata?: ProviderMetadata;
			approval: Approval;
	  }
	| {
			state: "approval-responded";
			input: unknown;
			output?: never;
			errorText?: never;
			callProviderMetadata?: ProviderMetadata;
			approval: ApprovalResponded;
	  }
	| {
			state: "output-available";
			input: unknown;
			output: unknown;
			errorText?: never;
			callProviderMetadata?: ProviderMetadata;
			resultProviderMetadata?: ProviderMetadata;
			preliminary?: boolean;
			approval?: ApprovalResponded & { approved: true };
	  }
	| {
			state: "output-error";
			input: unknown;
			rawInput?: unknown;
			output?: never;
			errorText: string;
			callProviderMetadata?: ProviderMetadata;
			resultProviderMetadata?: ProviderMetadata;
			approval?: ApprovalResponded & { approved: true };
	  }
	| {
			state: "output-denied";
			input: unknown;
			output?: never;
			errorText?: never;
			callProviderMetadata?: ProviderMetadata;
			approval: ApprovalDenied;
	  }
);

type Approval = {
	id: string;
	approved?: never;
	descriptor?: unknown;
	requestReason?: string;
	reason?: never;
	isAutomatic?: boolean;
	signature?: string;
	inputSchemaInput?: unknown;
};
type ApprovalResponded = {
	id: string;
	approved: boolean;
	descriptor?: unknown;
	requestReason?: string;
	reason?: string;
	isAutomatic?: boolean;
	signature?: string;
	inputSchemaInput?: unknown;
};
type ApprovalDenied = Omit<ApprovalResponded, "approved"> & { approved: false };

export type ToolPart = { type: `tool-${string}` } & ToolInvocation;

export type DynamicToolPart = {
	type: "dynamic-tool";
	dynamic?: false;
	toolName: string;
	toolCallId: string;
	title?: string;
	toolMetadata?: JSONObject;
	providerExecuted?: boolean;
} & (
	| {
			state: "input-streaming";
			input?: unknown;
			rawInput?: string;
			inputEncoding?: "json" | "text";
			output?: never;
			errorText?: never;
			callProviderMetadata?: ProviderMetadata;
			approval?: never;
	  }
	| {
			state: "input-available";
			input: unknown;
			output?: never;
			errorText?: never;
			callProviderMetadata?: ProviderMetadata;
			approval?: never;
	  }
	| {
			state: "approval-requested";
			input: unknown;
			output?: never;
			errorText?: never;
			callProviderMetadata?: ProviderMetadata;
			approval: Approval;
	  }
	| {
			state: "approval-responded";
			input: unknown;
			output?: never;
			errorText?: never;
			callProviderMetadata?: ProviderMetadata;
			approval: ApprovalResponded;
	  }
	| {
			state: "output-available";
			input: unknown;
			output: unknown;
			errorText?: never;
			callProviderMetadata?: ProviderMetadata;
			resultProviderMetadata?: ProviderMetadata;
			preliminary?: boolean;
			approval?: ApprovalResponded & { approved: true };
	  }
	| {
			state: "output-error";
			input: unknown;
			rawInput?: unknown;
			output?: never;
			errorText: string;
			callProviderMetadata?: ProviderMetadata;
			resultProviderMetadata?: ProviderMetadata;
			approval?: ApprovalResponded & { approved: true };
	  }
	| {
			state: "output-denied";
			input: unknown;
			output?: never;
			errorText?: never;
			callProviderMetadata?: ProviderMetadata;
			approval: ApprovalDenied;
	  }
);

type MessagePart =
	| TextPart
	| { type: "custom"; kind: `${string}.${string}`; providerMetadata?: ProviderMetadata }
	| ReasoningPart
	| ToolPart
	| DynamicToolPart
	| { type: "source-url"; sourceId: string; url: string; title?: string; providerMetadata?: ProviderMetadata }
	| { type: "source-document"; sourceId: string; mediaType: string; title: string; filename?: string; providerMetadata?: ProviderMetadata }
	| FilePart
	| { type: "reasoning-file"; mediaType: string; url: string; providerMetadata?: ProviderMetadata }
	| { type: `data-${string}`; id?: string; data: unknown }
	| { type: "steering-message"; id: string; parts: Array<TextPart | FilePart> }
	| { type: "step-start" };

export type { MessagePart };

export type Message = {
	id: string;
	role: "system" | "user" | "assistant";
	metadata?: unknown;
	parts: Array<MessagePart>;
};

export type MessageChunk =
	| { type: "text-start"; id: string; providerMetadata?: ProviderMetadata }
	| { type: "text-delta"; delta: string; id: string; providerMetadata?: ProviderMetadata }
	| { type: "text-end"; citations?: Array<Citation>; id: string; providerMetadata?: ProviderMetadata }
	| { type: "reasoning-start"; id: string; providerMetadata?: ProviderMetadata }
	| { type: "reasoning-delta"; id: string; delta: string; providerMetadata?: ProviderMetadata }
	| { type: "reasoning-end"; id: string; providerMetadata?: ProviderMetadata }
	| { type: "custom"; kind: `${string}.${string}`; providerMetadata?: ProviderMetadata }
	| { type: "error"; errorText: string }
	| { type: "tool-input-available"; toolCallId: string; toolName: string; input: unknown; providerExecuted?: boolean; providerMetadata?: ProviderMetadata; toolMetadata?: JSONObject; dynamic?: boolean; title?: string }
	| { type: "tool-input-error"; toolCallId: string; toolName: string; input: unknown; providerExecuted?: boolean; providerMetadata?: ProviderMetadata; toolMetadata?: JSONObject; dynamic?: boolean; errorText: string; title?: string }
	| { type: "tool-approval-request"; approvalId: string; toolCallId: string; approvalDescriptor?: unknown; inputSchemaInput?: unknown; reason?: string; isAutomatic?: boolean; signature?: string }
	| { type: "tool-approval-response"; approvalId: string; approved: boolean; reason?: string; providerExecuted?: boolean; providerMetadata?: ProviderMetadata }
	| { type: "tool-output-available"; toolCallId: string; output: unknown; providerExecuted?: boolean; providerMetadata?: ProviderMetadata; toolMetadata?: JSONObject; dynamic?: boolean; preliminary?: boolean }
	| { type: "tool-output-error"; toolCallId: string; errorText: string; providerExecuted?: boolean; providerMetadata?: ProviderMetadata; toolMetadata?: JSONObject; dynamic?: boolean }
	| { type: "tool-output-denied"; toolCallId: string }
	| { type: "tool-input-start"; toolCallId: string; toolName: string; inputEncoding?: "json" | "text"; providerExecuted?: boolean; providerMetadata?: ProviderMetadata; toolMetadata?: JSONObject; dynamic?: boolean; title?: string }
	| { type: "tool-input-delta"; toolCallId: string; inputTextDelta: string }
	| { type: "source-url"; sourceId: string; url: string; title?: string; providerMetadata?: ProviderMetadata }
	| { type: "source-document"; sourceId: string; mediaType: string; title: string; filename?: string; providerMetadata?: ProviderMetadata }
	| { type: "file"; url: string; mediaType: string; providerMetadata?: ProviderMetadata }
	| { type: "reasoning-file"; url: string; mediaType: string; providerMetadata?: ProviderMetadata }
	| { type: `data-${string}`; id?: string; data: unknown; transient?: boolean }
	| { type: "steering-message"; id: string; parts: Array<TextPart | FilePart> }
	| { type: "start-step" }
	| { type: "finish-step" }
	| { type: "reset-step" }
	| { type: "start"; messageId?: string; messageMetadata?: unknown }
	| { type: "finish"; finishReason?: FinishReason; messageMetadata?: unknown }
	| { type: "abort"; reason?: string }
	| { type: "message-metadata"; messageMetadata: unknown };
