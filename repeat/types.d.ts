declare module "node:child_process" {
	export const spawnSync: any;
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

declare module "@mariozechner/pi-coding-agent" {
	export type ExtensionAPI = any;
	export const DynamicBorder: any;
	export const createWriteTool: any;
	export const createEditTool: any;
}

declare module "@mariozechner/pi-tui" {
	export const Container: any;
	export const SelectList: any;
	export const Spacer: any;
	export const Text: any;
	export const getEditorKeybindings: any;
	export const truncateToWidth: any;
	export type SelectItem = any;
}

declare const process: any;
