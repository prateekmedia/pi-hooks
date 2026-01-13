declare module "node:child_process" {
	export const spawn: any;
	export const spawnSync: any;
}

declare module "node:crypto" {
	const crypto: any;
	export = crypto;
}

declare module "node:fs" {
	const fs: any;
	export = fs;
}

declare module "node:os" {
	const os: any;
	export = os;
}

declare module "node:path" {
	const path: any;
	export = path;
}

declare module "@mariozechner/pi-agent-core" {
	export type AgentToolResult = any;
}

declare module "@mariozechner/pi-ai" {
	export type TextContent = { type: "text"; text: string; textSignature?: string };
	export type ImageContent = { type: "image"; data: string; mimeType: string };
	export type Message = any;
	export const StringEnum: any;
}

declare module "@mariozechner/pi-coding-agent" {
	export type ExtensionAPI = any;
	export const getMarkdownTheme: any;
	export class AssistantMessageComponent {
		constructor(...args: any[]);
	}
	export class DynamicBorder {
		constructor(...args: any[]);
	}
	export class ToolExecutionComponent {
		constructor(...args: any[]);
		updateResult(...args: any[]): void;
		setExpanded(...args: any[]): void;
	}
	export class UserMessageComponent {
		constructor(...args: any[]);
	}
}

declare module "@mariozechner/pi-tui" {
	export class Box {
		constructor(...args: any[]);
		addChild(...args: any[]): void;
		clear(): void;
		setBgFn(...args: any[]): void;
	}
	export class Container {
		children: any[];
		constructor(...args: any[]);
		addChild(...args: any[]): void;
		removeChild(...args: any[]): void;
		clear(): void;
		invalidate(): void;
		render(...args: any[]): any;
	}
	export const truncateToWidth: any;
	export class Markdown {
		constructor(...args: any[]);
		setText(...args: any[]): void;
	}
	export class Spacer {
		constructor(...args: any[]);
	}
	export class Text {
		constructor(...args: any[]);
		setText(...args: any[]): void;
	}
	export const matchesKey: any;
}

declare module "@sinclair/typebox" {
	export const Type: any;
	export type Static = any;
}

declare const process: any;
