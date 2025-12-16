import type { ResolvedUsageSummarySettings } from "../context.js";

export type TransportName = "slack" | "discord";

export type ReplyTarget = "response" | "details";

export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
	email?: string;
}

export interface TransportFormatting {
	italic(text: string): string;
	bold(text: string): string;
	code(text: string): string;
	codeBlock(text: string): string;
}

export interface ToolResultData {
	toolName: string;
	label?: string;
	args?: string;
	result: string;
	isError: boolean;
	durationSecs: string;
}

export interface UsageSummaryData {
	tokens: { input: number; output: number };
	cache: { read: number; write: number };
	context: { used: number; max: number; percent: string };
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface FormatterOutput {
	text?: string;
	title?: string;
	color?: number;
	fields?: Array<{ name: string; value: string; inline?: boolean }>;
	footer?: string | null;
}

export interface TransportContext {
	transport: TransportName;

	// Host filesystem layout (absolute paths)
	workingDir: string;
	channelDir: string;

	// Optional display metadata
	channelName?: string;
	guildId?: string;
	guildName?: string;

	// The triggering message
	message: {
		text: string;
		rawText: string;
		userId: string;
		userName?: string;
		userEmail?: string;
		displayName?: string;
		channelId: string;
		messageId: string; // Slack: ts, Discord: snowflake
		attachments: Array<{ local: string }>;
		reactions?: Array<{ emoji: string; count: number }>;
	};

	// Used for system prompt channel/user mapping
	channels: ChannelInfo[];
	users: UserInfo[];

	// Formatting + splitting owned by transport
	formatting: TransportFormatting;
	limits: {
		responseMaxChars: number;
		detailsMaxChars: number;
	};

	// Slack threads are replies TO the response message, so duplicating keeps main channel clean.
	// Discord threads include the parent message, so duplicating would show text twice.
	duplicateResponseToDetails: boolean;

	// When false, suppresses all "details" output (tool results, usage summaries, errors in threads).
	showDetails: boolean;

	// Messaging API
	send(target: ReplyTarget, text: string, opts?: { log?: boolean }): Promise<void>;
	replaceResponse(text: string): Promise<void>;

	setTyping(isTyping: boolean): Promise<void>;
	setWorking(working: boolean): Promise<void>;
	deleteResponseAndDetails(): Promise<void>;

	uploadFile(filePath: string, title?: string): Promise<void>;

	// Optional transport-specific UX
	sendToolResult?: (data: ToolResultData) => Promise<void>;
	sendUsageSummary?: (
		data: UsageSummaryData,
		settings: ResolvedUsageSummarySettings,
		formatterOutput?: FormatterOutput,
	) => Promise<void>;
	addStopControl?: () => Promise<void>;
	removeStopControl?: () => Promise<void>;
}
