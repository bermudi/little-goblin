// Goblin's model-facing prompt shape — what a turn sends the model. This is
// a structural copy of the AI SDK ModelMessage family so requests stay
// byte-identical. src/prompt-message.test.ts is the only place the SDK
// shape is compared; an ai bump that changes it fails typecheck there.
import type { JSONValue, ProviderMetadata } from "./message.ts";

type ProviderOptions = ProviderMetadata;
type DataContent = string | Uint8Array | ArrayBuffer | Buffer;
type ProviderReference = Record<string, string>;
type FileData =
	| { type: "data"; data: DataContent }
	| { type: "url"; url: URL }
	| { type: "reference"; reference: ProviderReference }
	| { type: "text"; text: string };

export type PromptTextPart = {
	type: "text";
	text: string;
	providerOptions?: ProviderOptions;
};

export type PromptImagePart = {
	type: "image";
	image: DataContent | URL | ProviderReference;
	mediaType?: string;
	providerOptions?: ProviderOptions;
};

export type PromptFilePart = {
	type: "file";
	data: FileData | DataContent | URL | ProviderReference;
	filename?: string;
	mediaType: string;
	providerOptions?: ProviderOptions;
};

export type PromptReasoningPart = {
	type: "reasoning";
	text: string;
	providerOptions?: ProviderOptions;
};

export type PromptCustomPart = {
	type: "custom";
	kind: `${string}.${string}`;
	providerOptions?: ProviderOptions;
};

export type PromptReasoningFilePart = {
	type: "reasoning-file";
	data:
		| DataContent
		| URL
		| { type: "data"; data: DataContent }
		| { type: "url"; url: URL };
	mediaType: string;
	providerOptions?: ProviderOptions;
};

export type PromptToolCallPart = {
	type: "tool-call";
	toolCallId: string;
	toolName: string;
	input: unknown;
	providerOptions?: ProviderOptions;
	providerExecuted?: boolean;
};

export type ToolResultOutput =
	| { type: "text"; value: string; providerOptions?: ProviderOptions }
	| { type: "json"; value: JSONValue; providerOptions?: ProviderOptions }
	| { type: "execution-denied"; reason?: string; providerOptions?: ProviderOptions }
	| { type: "error-text"; value: string; providerOptions?: ProviderOptions }
	| { type: "error-json"; value: JSONValue; providerOptions?: ProviderOptions }
	| {
			type: "content";
			value: Array<
				| { type: "text"; text: string; providerOptions?: ProviderOptions }
				| {
						type: "file";
						data: FileData;
						mediaType: string;
						filename?: string;
						providerOptions?: ProviderOptions;
				  }
				| { type: "file-data"; data: string; mediaType: string; filename?: string; providerOptions?: ProviderOptions }
				| { type: "file-url"; url: string; mediaType?: string; providerOptions?: ProviderOptions }
				| { type: "file-id"; fileId: string | Record<string, string>; providerOptions?: ProviderOptions }
				| { type: "file-reference"; providerReference: ProviderReference; providerOptions?: ProviderOptions }
				| { type: "image-data"; data: string; mediaType: string; providerOptions?: ProviderOptions }
				| { type: "image-url"; url: string; providerOptions?: ProviderOptions }
				| { type: "image-file-id"; fileId: string | Record<string, string>; providerOptions?: ProviderOptions }
				| { type: "image-file-reference"; providerReference: ProviderReference; providerOptions?: ProviderOptions }
				| { type: "custom"; providerOptions?: ProviderOptions }
			>;
			providerOptions?: ProviderOptions;
	  };

export type PromptToolResultPart = {
	type: "tool-result";
	toolCallId: string;
	toolName: string;
	output: ToolResultOutput;
	providerOptions?: ProviderOptions;
};

export type PromptToolApprovalRequest = {
	type: "tool-approval-request";
	approvalId: string;
	toolCallId: string;
	reason?: string;
	isAutomatic?: boolean;
	signature?: string;
	inputSchemaInput?: unknown;
};

export type PromptToolApprovalResponse = {
	type: "tool-approval-response";
	approvalId: string;
	approved: boolean;
	reason?: string;
	providerExecuted?: boolean;
};

export type UserContent = string | Array<PromptTextPart | PromptImagePart | PromptFilePart>;
export type AssistantContent =
	| string
	| Array<
			| PromptTextPart
			| PromptCustomPart
			| PromptFilePart
			| PromptReasoningPart
			| PromptReasoningFilePart
			| PromptToolCallPart
			| PromptToolResultPart
			| PromptToolApprovalRequest
	  >;
export type ToolContent = Array<PromptToolResultPart | PromptToolApprovalResponse>;

type PromptMessageMetadata = { providerOptions?: ProviderOptions };

export type PromptMessage =
	| ({ role: "system"; content: string } & PromptMessageMetadata)
	| ({ role: "user"; content: UserContent } & PromptMessageMetadata)
	| ({ role: "assistant"; content: AssistantContent } & PromptMessageMetadata)
	| ({ role: "tool"; content: ToolContent } & PromptMessageMetadata);
