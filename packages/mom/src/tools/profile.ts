import type { AgentTool, TextContent } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { DiscordProfileActivityType, DiscordProfileSettings, SlackProfileSettings } from "../context.js";
import { MomSettingsManager } from "../context.js";
import type { TransportContext, TransportName } from "../transport/types.js";

export interface ProfileRuntime {
	updateDiscordProfile?: (updates: Partial<DiscordProfileSettings>) => Promise<{ success: boolean; message: string }>;
	updateSlackProfile?: (updates: Partial<SlackProfileSettings>) => Promise<{ success: boolean; message: string }>;
}

const profileSchema = Type.Object({
	label: Type.String({ description: "Brief description shown to user" }),
	transport: Type.Optional(StringEnum(["discord", "slack"])),

	// Shared-ish
	username: Type.Optional(Type.String({ description: "Bot display name (Discord/Slack)" })),

	// Discord
	avatar: Type.Optional(Type.String({ description: "Discord avatar URL or local path (Discord only)" })),
	status: Type.Optional(StringEnum(["online", "idle", "dnd", "invisible"])),
	activityName: Type.Optional(Type.String({ description: "Discord activity name (Discord only)" })),
	activityType: Type.Optional(StringEnum(["Playing", "Watching", "Listening", "Competing", "Streaming"])),

	// Slack
	iconUrl: Type.Optional(
		Type.String({ description: "Slack icon URL override (Slack only; requires chat:write.customize)" }),
	),
	iconEmoji: Type.Optional(
		Type.String({
			description: "Slack icon emoji override, e.g. :robot_face: (Slack only; requires chat:write.customize)",
		}),
	),
});

type ProfileArgs = {
	label: string;
	transport?: string;
	username?: string;
	avatar?: string;
	status?: string;
	activityName?: string;
	activityType?: string;
	iconUrl?: string;
	iconEmoji?: string;
};

export function createProfileTool(
	getCtx: () => TransportContext | null,
	getRuntime: () => ProfileRuntime | null,
): AgentTool<typeof profileSchema> {
	let cachedSettings: { workingDir: string; manager: MomSettingsManager } | null = null;
	return {
		name: "profile",
		label: "profile",
		description:
			"Update bot profile settings (persisted to settings.json). Discord supports username/avatar/status/activity. Slack supports per-message username/icon overrides (requires chat:write.customize).",
		parameters: profileSchema,
		execute: async (
			_toolCallId: string,
			args: ProfileArgs,
			_signal?: AbortSignal,
		): Promise<{ content: TextContent[]; details: undefined }> => {
			const ctx = getCtx();
			if (!ctx) throw new Error("No active transport context");

			const targetTransport = (args.transport ?? ctx.transport) as TransportName;
			const runtime = getRuntime();
			let settingsManager: MomSettingsManager;
			if (cachedSettings?.workingDir === ctx.workingDir) {
				settingsManager = cachedSettings.manager;
			} else {
				settingsManager = new MomSettingsManager(ctx.workingDir);
				cachedSettings = { workingDir: ctx.workingDir, manager: settingsManager };
			}

			if (targetTransport === "discord") {
				if (args.iconEmoji || args.iconUrl) {
					throw new Error("iconEmoji/iconUrl are Slack-only fields; omit them for Discord profile updates");
				}

				if (args.activityType && !args.activityName) {
					throw new Error("activityType requires activityName");
				}

				const updates: Partial<DiscordProfileSettings> = {};
				if (args.username !== undefined) updates.username = args.username;
				if (args.avatar !== undefined) updates.avatar = args.avatar;
				if (args.status !== undefined) updates.status = args.status as "online" | "idle" | "dnd" | "invisible";
				if (args.activityName) {
					updates.activity = {
						name: args.activityName,
						type: (args.activityType ?? "Playing") as DiscordProfileActivityType,
					};
				}

				let applied: { success: boolean; message: string } | null = null;
				if (runtime?.updateDiscordProfile && ctx.transport === "discord") {
					applied = await runtime.updateDiscordProfile(updates);
				} else {
					settingsManager.setDiscordProfile(updates);
				}

				const lines: string[] = [];
				lines.push(`Saved Discord profile updates to settings.json.`);
				lines.push(formatChangedFields("Discord", updates));
				if (applied) {
					lines.push(applied.success ? `Applied live: yes` : `Applied live: partial/failure`);
					lines.push(`Apply result: ${applied.message}`);
				} else {
					lines.push(`Applied live: no (restart mom with --transport=discord to apply)`);
				}

				return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }], details: undefined };
			}

			// Slack
			if (args.avatar || args.status || args.activityName || args.activityType) {
				throw new Error(
					"avatar/status/activityName/activityType are Discord-only fields; omit them for Slack profile updates",
				);
			}

			const updates: Partial<SlackProfileSettings> = {};
			if (args.username !== undefined) updates.username = args.username;
			if (args.iconUrl !== undefined) updates.iconUrl = args.iconUrl;
			if (args.iconEmoji !== undefined) updates.iconEmoji = args.iconEmoji;

			let applied: { success: boolean; message: string } | null = null;
			if (runtime?.updateSlackProfile && ctx.transport === "slack") {
				applied = await runtime.updateSlackProfile(updates);
			} else {
				settingsManager.setSlackProfile(updates);
			}

			const lines: string[] = [];
			lines.push(`Saved Slack profile updates to settings.json.`);
			lines.push(formatChangedFields("Slack", updates));
			lines.push(
				`Note: Slack username/icon overrides require the Slack app to have chat:write.customize and may be ignored or rejected without it.`,
			);
			if (applied) {
				lines.push(applied.success ? `Applied live: yes` : `Applied live: partial/failure`);
				lines.push(`Apply result: ${applied.message}`);
			} else {
				lines.push(`Applied live: no (restart mom with --transport=slack to apply)`);
			}

			return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }], details: undefined };
		},
	};
}

function formatChangedFields(prefix: string, updates: Record<string, unknown>): string {
	const keys = Object.keys(updates).filter((k) => updates[k] !== undefined);
	if (keys.length === 0) return `${prefix} changes: (none)`;
	return `${prefix} changes: ${keys.join(", ")}`;
}
