/**
 * Permission Gate Hook
 *
 * Implements layered permission control with project-scoped settings:
 * - Git repos: Settings stored in <git-root>/.pi/settings.json
 *   (automatically added to .git/info/exclude on first creation)
 * - Non-git: Settings stored in ~/.pi/agent/settings.json
 * - First run prompts for preference, saves for future sessions
 * - Can escalate via permission prompts during session
 *
 * Autonomy Levels:
 * - off: Read-only mode (safest)
 * - low: File edits allowed
 * - medium: Dev commands allowed (npm, git, etc.)
 * - high: All commands allowed
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { HookAPI, HookEventContext } from "@mariozechner/pi-coding-agent/hooks";

// ============================================================================
// TYPES & CONFIGURATION
// ============================================================================

type AutonomyLevel = "off" | "low" | "medium" | "high";

interface AutonomyConfig {
	label: string;
	description: string;
	allowReadOnlyBash: boolean;
	allowSafeWrites: boolean;
	allowMediumBash: boolean;
	allowAllBash: boolean;
	allowProtectedPaths: boolean;
}

const AUTONOMY_CONFIGS: Record<AutonomyLevel, AutonomyConfig> = {
	off: {
		label: "Off",
		description: "Read-only mode",
		allowReadOnlyBash: true,
		allowSafeWrites: false,
		allowMediumBash: false,
		allowAllBash: false,
		allowProtectedPaths: false,
	},
	low: {
		label: "Low",
		description: "File edits allowed",
		allowReadOnlyBash: true,
		allowSafeWrites: true,
		allowMediumBash: false,
		allowAllBash: false,
		allowProtectedPaths: false,
	},
	medium: {
		label: "Medium",
		description: "Dev commands allowed",
		allowReadOnlyBash: true,
		allowSafeWrites: true,
		allowMediumBash: true,
		allowAllBash: false,
		allowProtectedPaths: false,
	},
	high: {
		label: "High",
		description: "All commands allowed",
		allowReadOnlyBash: true,
		allowSafeWrites: true,
		allowMediumBash: true,
		allowAllBash: true,
		allowProtectedPaths: true,
	},
};

const AUTONOMY_ORDER: AutonomyLevel[] = ["off", "low", "medium", "high"];

// Commands always allowed without prompting
const COMMAND_ALLOWLIST: string[] = [
	"ls", "pwd", "echo", "cat", "head", "tail", "wc", "which", "whoami",
	"date", "uname", "env", "printenv", "type", "file", "stat", "df", "du",
	"free", "uptime", "grep", "find",
];

// Commands always dangerous - require confirmation even at high
const COMMAND_DENYLIST_PATTERNS: RegExp[] = [
	/\brm\s+(-rf?|--recursive|--force)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
	/\bmkfs\b/i,
	/\bdd\s+.*of=/i,
	/\b(shutdown|reboot|halt|poweroff)\b/i,
	/\b>\s*\/dev\/sd/i,
	/\brm\s+.*\/\s*$/i,
	/\bgit\s+push\s+.*--force/i,
	/\bgit\s+reset\s+--hard/i,
	/\bnpm\s+publish/i,
	/\bcurl\s+.*\|\s*(ba)?sh/i,
	/\bwget\s+.*\|\s*(ba)?sh/i,
];

// Paths that should never be written to
const PROTECTED_PATHS: string[] = [
	".env", ".env.local", ".env.production",
	".git/", "node_modules/",
	"package-lock.json", "yarn.lock", "pnpm-lock.yaml",
];

// ============================================================================
// GIT & SETTINGS HELPERS
// ============================================================================

/**
 * Find the git root directory by walking up from cwd.
 * Returns null if not in a git repo.
 */
function findGitRoot(cwd: string): string | null {
	let current = path.resolve(cwd);
	const root = path.parse(current).root;

	while (current !== root) {
		if (fs.existsSync(path.join(current, ".git"))) {
			return current;
		}
		current = path.dirname(current);
	}

	// Check root as well
	if (fs.existsSync(path.join(root, ".git"))) {
		return root;
	}

	return null;
}

/**
 * Ensure .pi/ is in local git exclude (not shared .gitignore)
 * Uses .git/info/exclude for regular repos
 * For worktrees, finds the main .git directory
 */
function ensureLocalGitExclude(gitRoot: string): void {
	const piPattern = ".pi/";

	try {
		// Handle worktrees: .git might be a file pointing to the real git dir
		const gitPath = path.join(gitRoot, ".git");
		let excludePath: string;

		if (fs.statSync(gitPath).isFile()) {
			// Worktree: .git is a file containing "gitdir: /path/to/real/.git/worktrees/name"
			const gitFileContent = fs.readFileSync(gitPath, "utf-8").trim();
			const match = gitFileContent.match(/^gitdir:\s*(.+)$/);
			if (match) {
				// Go up from worktrees/name to the main .git, then info/exclude
				const worktreeGitDir = match[1];
				const mainGitDir = path.resolve(path.dirname(worktreeGitDir), "..");
				excludePath = path.join(mainGitDir, "info", "exclude");
			} else {
				return; // Can't parse, skip
			}
		} else {
			// Regular repo
			excludePath = path.join(gitPath, "info", "exclude");
		}

		// Read existing exclude file
		let content = "";
		if (fs.existsSync(excludePath)) {
			content = fs.readFileSync(excludePath, "utf-8");
			// Check if already excluded
			const lines = content.split("\n").map(l => l.trim());
			if (lines.some(l => l === ".pi" || l === ".pi/" || l === "/.pi" || l === "/.pi/")) {
				return; // Already excluded
			}
		}

		// Ensure info directory exists
		const infoDir = path.dirname(excludePath);
		if (!fs.existsSync(infoDir)) {
			fs.mkdirSync(infoDir, { recursive: true });
		}

		// Append .pi/ to exclude
		const newContent = content.endsWith("\n") || content === ""
			? content + piPattern + "\n"
			: content + "\n" + piPattern + "\n";

		fs.writeFileSync(excludePath, newContent);
	} catch {
		// Ignore errors (e.g., permission denied)
	}
}

/**
 * Get the settings file path based on context.
 * Returns { path, isProject, gitRoot }
 */
function getSettingsContext(cwd: string): { settingsPath: string; isProject: boolean; gitRoot: string | null } {
	const gitRoot = findGitRoot(cwd);

	if (gitRoot) {
		return {
			settingsPath: path.join(gitRoot, ".pi", "settings.json"),
			isProject: true,
			gitRoot,
		};
	}

	return {
		settingsPath: path.join(process.env.HOME || "", ".pi", "agent", "settings.json"),
		isProject: false,
		gitRoot: null,
	};
}

/**
 * Load settings from a file
 */
function loadSettingsFile(settingsPath: string): Record<string, unknown> {
	try {
		return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
	} catch {
		return {};
	}
}

/**
 * Save settings to a file
 */
function saveSettingsFile(settingsPath: string, settings: Record<string, unknown>): void {
	try {
		const dir = path.dirname(settingsPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
	} catch {
		// Ignore errors
	}
}

/**
 * Load autonomy level from appropriate settings file
 */
function loadAutonomyLevel(cwd: string): { level: AutonomyLevel | null; isProject: boolean; settingsPath: string; gitRoot: string | null } {
	const ctx = getSettingsContext(cwd);
	const settings = loadSettingsFile(ctx.settingsPath);
	const level = (settings.autonomyLevel as string)?.toLowerCase() as AutonomyLevel;

	if (level && AUTONOMY_ORDER.includes(level)) {
		return { level, ...ctx };
	}

	// Also check environment variable as override
	const envLevel = process.env.AUTONOMY_LEVEL?.toLowerCase() as AutonomyLevel;
	if (envLevel && AUTONOMY_ORDER.includes(envLevel)) {
		return { level: envLevel, ...ctx };
	}

	return { level: null, ...ctx };
}

/**
 * Save autonomy level to appropriate settings file
 */
function saveAutonomyLevel(settingsPath: string, level: AutonomyLevel, gitRoot: string | null): void {
	// Check if .pi/settings.json already exists (for gitexclude logic)
	const settingsExisted = fs.existsSync(settingsPath);

	const settings = loadSettingsFile(settingsPath);
	settings.autonomyLevel = level;
	saveSettingsFile(settingsPath, settings);

	// Only add to local git exclude if this is a new .pi directory
	if (gitRoot && !settingsExisted) {
		ensureLocalGitExclude(gitRoot);
	}
}

// ============================================================================
// COMMAND CLASSIFICATION (regex-based for performance)
// ============================================================================

// Dangerous chaining patterns (blocks ;, &&, &, ||, `, $())
// Note: \; in find -exec is safe, so we check for ; not preceded by \
const DANGEROUS_CHAINING_RE = /`|&&|\|\||\$\(|&|(?<!\\);/;

// Allowlist: always permitted commands (single regex)
const ALLOWLIST_RE = /^(ls|pwd|echo|cat|head|tail|wc|which|whoami|date|uname|env|printenv|type|file|stat|df|du|free|uptime|grep|find)\b/;

// Safe pipe targets (output formatters)
const SAFE_PIPE_RE = /^(head|tail|wc|sort|uniq|cut|awk|sed|tr|grep|less|more)\b/;

// Read-only commands (extends allowlist)
const READ_ONLY_RE = /^(ls|pwd|echo|cat|head|tail|wc|which|whoami|date|uname|env|printenv|type|file|stat|df|du|free|uptime|grep|find|ps|top|htop|locate|tree)\b/;

// Read-only prefixes (git, npm, etc.)
const READ_ONLY_PREFIX_RE = /^(git\s+(status|log|diff|branch|show)|npm\s+(list|ls)|yarn\s+list|pnpm\s+list|node\s+--version|npm\s+--version|python\s+--version)\b/;

// Medium-risk commands (dev operations)
const MEDIUM_COMMAND_RE = /^(npm\s+(install|ci|test|run|build|start)|yarn\s+(install|add|test|build|start)|pnpm\s+(install|add|test|build|start)|pip\s+install|cargo\s+(build|test|run)|go\s+(build|test|run|get)|make|git\s+(add|commit|stash|checkout|branch|merge|rebase|fetch|pull)|mkdir|touch)\b/i;

/**
 * Check if command is "allowedCmd | safeTarget" pattern (up to 2 pipes)
 */
function isAllowedPipeline(command: string): boolean {
	const pipeIdx = command.indexOf("|");
	if (pipeIdx === -1) return false;
	
	const segments = command.split("|");
	if (segments.length < 2 || segments.length > 3) return false;
	
	// First segment must match allowlist
	if (!ALLOWLIST_RE.test(segments[0].trim())) return false;
	
	// Remaining segments must be safe pipe targets
	for (let i = 1; i < segments.length; i++) {
		if (!SAFE_PIPE_RE.test(segments[i].trim())) return false;
	}
	
	return true;
}

function isInAllowlist(command: string): boolean {
	if (DANGEROUS_CHAINING_RE.test(command)) return false;
	const trimmed = command.trim();
	
	// Check pipeline pattern
	if (trimmed.includes("|")) return isAllowedPipeline(trimmed);
	
	// Simple command
	return ALLOWLIST_RE.test(trimmed);
}

function matchesDenylist(command: string): boolean {
	return COMMAND_DENYLIST_PATTERNS.some(p => p.test(command));
}

function isReadOnlyCommand(command: string): boolean {
	if (DANGEROUS_CHAINING_RE.test(command)) return false;
	const trimmed = command.trim();
	
	// Check pipeline
	if (trimmed.includes("|") && isAllowedPipeline(trimmed)) return true;
	
	// Check read-only patterns
	return READ_ONLY_RE.test(trimmed) || READ_ONLY_PREFIX_RE.test(trimmed);
}

function isMediumCommand(command: string): boolean {
	if (DANGEROUS_CHAINING_RE.test(command)) return false;
	return MEDIUM_COMMAND_RE.test(command.trim());
}

function isProtectedPath(filePath: string): boolean {
	const normalized = filePath.replace(/^~/, process.env.HOME || "");
	return PROTECTED_PATHS.some(p => normalized.includes(p.replace(/^~/, process.env.HOME || "")));
}

function isWithinProjectDir(filePath: string, cwd: string): boolean {
	const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
	const normalizedCwd = path.resolve(cwd);
	return absolute.startsWith(normalizedCwd + path.sep) || absolute === normalizedCwd;
}

function getLevelForBashCommand(command: string): AutonomyLevel {
	if (isReadOnlyCommand(command)) return "off";
	if (isMediumCommand(command)) return "medium";
	return "high";
}

function getLevelForWrite(withinProject: boolean): AutonomyLevel {
	return withinProject ? "low" : "high";
}

// ============================================================================
// AUTONOMY SELECTOR UI
// ============================================================================

async function showAutonomySelector(
	ctx: HookEventContext,
	currentLevel: AutonomyLevel,
	isInitial: boolean = false,
	isProject: boolean = false
): Promise<AutonomyLevel | null> {
	const scope = isProject ? "this project" : "global";
	const title = isInitial
		? `🔒 Select autonomy level for ${scope}`
		: `🔒 Select autonomy level (current: ${AUTONOMY_CONFIGS[currentLevel].label})`;

	const options = AUTONOMY_ORDER.map(level => {
		const config = AUTONOMY_CONFIGS[level];
		const marker = !isInitial && level === currentLevel ? " ← current" : "";
		return `${config.label}: ${config.description}${marker}`;
	});

	const choice = await ctx.ui.select(title, options);
	if (!choice) return null;

	const selectedLabel = choice.split(":")[0].trim();
	return AUTONOMY_ORDER.find(l => AUTONOMY_CONFIGS[l].label === selectedLabel) || null;
}

// ============================================================================
// MAIN HOOK
// ============================================================================

export default function (pi: HookAPI) {
	// State
	let autonomyLevel: AutonomyLevel = "high";
	let settingsPath: string = "";
	let isProject: boolean = false;
	let gitRoot: string | null = null;
	let sessionDeniedCommands = new Set<string>();

	const getConfig = () => AUTONOMY_CONFIGS[autonomyLevel];

	// ========================================================================
	// SESSION START - Load or prompt for autonomy level
	// ========================================================================
	pi.on("session", async (event, ctx) => {
		if (event.reason === "start") {
			// Load settings based on git context
			const loaded = loadAutonomyLevel(ctx.cwd);
			settingsPath = loaded.settingsPath;
			isProject = loaded.isProject;
			gitRoot = loaded.gitRoot;

			if (loaded.level) {
				// Use saved preference
				autonomyLevel = loaded.level;
				const scope = isProject ? "project" : "global";
				if (ctx.hasUI) {
					ctx.ui.notify(
						`🔒 Autonomy: ${AUTONOMY_CONFIGS[autonomyLevel].label} (${scope})`,
						"info"
					);
				}
			} else if (ctx.hasUI) {
				// No preference - prompt user
				const selectedLevel = await showAutonomySelector(ctx, "high", true, isProject);

				if (selectedLevel) {
					autonomyLevel = selectedLevel;
					saveAutonomyLevel(settingsPath, autonomyLevel, gitRoot);
					const scope = isProject ? "project" : "global";
					ctx.ui.notify(
						`🔒 Autonomy: ${AUTONOMY_CONFIGS[autonomyLevel].label} - saved to ${scope} settings`,
						"info"
					);
				} else {
					// Cancelled - default to high
					autonomyLevel = "high";
					ctx.ui.notify(
						`🔒 Autonomy: High (default)`,
						"info"
					);
				}
			} else {
				// No UI (print mode: pi -p) - default to high to avoid blocking
				autonomyLevel = "high";
			}

	});

	// ========================================================================
	// BASH COMMAND PERMISSION GATE
	// ========================================================================
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = (event.input.command as string).trim();
		const config = getConfig();

		// Always allow allowlisted commands
		if (isInAllowlist(command)) {
			return undefined;
		}

		// Check denylist (dangerous commands) - always prompt, even at High
		if (matchesDenylist(command)) {
			// Previously denied this session (only for dangerous commands)
			if (sessionDeniedCommands.has(command)) {
				return { block: true, reason: "Previously denied this session" };
			}

			if (!ctx.hasUI) {
				return { block: true, reason: "Dangerous command blocked (no UI)" };
			}

			// Prompt for dangerous commands
			const choice = await ctx.ui.select(
				`⚠️ DANGEROUS command:\n\n  ${command}\n`,
				["Allow once", "Always block", "Block"]
			);

			if (choice === "Allow once") return undefined;

			if (choice === "Always block") {
				sessionDeniedCommands.add(command);
				return { block: true, reason: "Blocked by user" };
			}

			return { block: true, reason: "Blocked by user" };
		}

		// Auto-allow based on autonomy level
		if (config.allowAllBash) return undefined;
		if (config.allowMediumBash && isMediumCommand(command)) return undefined;
		if (config.allowReadOnlyBash && isReadOnlyCommand(command)) return undefined;

		// Need to prompt
		if (!ctx.hasUI) {
			return { block: true, reason: "Command blocked (no UI)" };
		}

		const requiredLevel = getLevelForBashCommand(command);
		const requiredIndex = AUTONOMY_ORDER.indexOf(requiredLevel);
		const currentIndex = AUTONOMY_ORDER.indexOf(autonomyLevel);

		const options: string[] = ["Allow once"];
		if (requiredIndex > currentIndex) {
			options.push(`Allow all (${AUTONOMY_CONFIGS[requiredLevel].label})`);
		}
		options.push("Block");

		const choice = await ctx.ui.select(
			`🔒 Command requires permission:\n\n  ${command}\n\nCurrent: ${config.label} - ${config.description}`,
			options
		);

		if (choice === "Allow once") return undefined;

		if (choice === "Block") {
			return { block: true, reason: "Blocked by user" };
		}

		// Escalate
		if (requiredIndex > currentIndex && choice === `Allow all (${AUTONOMY_CONFIGS[requiredLevel].label})`) {
			autonomyLevel = requiredLevel;
			saveAutonomyLevel(settingsPath, autonomyLevel, gitRoot);
			const scope = isProject ? "project" : "global";
			ctx.ui.notify(`🔓 Autonomy → ${AUTONOMY_CONFIGS[requiredLevel].label} (saved to ${scope})`, "info");
			return undefined;
		}

		return { block: true, reason: "Blocked by user" };
	});

	// ========================================================================
	// FILE WRITE/EDIT PERMISSION GATE
	// ========================================================================
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

		const filePath = event.input.path as string;
		const config = getConfig();

		// Protected paths - auto-allow at High, prompt otherwise
		if (isProtectedPath(filePath)) {
			// Auto-allow at High autonomy
			if (config.allowProtectedPaths) return undefined;

			if (!ctx.hasUI) {
				return { block: true, reason: "Protected path blocked (no UI)" };
			}

			const choice = await ctx.ui.select(
				`⚠️ PROTECTED path:\n\n  ${filePath}\n\nCurrent: ${config.label}`,
				["Allow once", "Allow all (High)", "Block"]
			);

			if (choice === "Allow once") return undefined;

			if (choice === "Allow all (High)") {
				autonomyLevel = "high";
				saveAutonomyLevel(settingsPath, autonomyLevel, gitRoot);
				const scope = isProject ? "project" : "global";
				ctx.ui.notify(`🔓 Autonomy → High (saved to ${scope})`, "info");
				return undefined;
			}

			return { block: true, reason: "Blocked by user" };
		}

		const withinProject = isWithinProjectDir(filePath, ctx.cwd);

		// Auto-allow if autonomy permits
		if (config.allowSafeWrites && withinProject) return undefined;

		// Need to prompt
		if (!ctx.hasUI) {
			return { block: true, reason: "Write blocked (no UI)" };
		}

		const action = event.toolName === "write" ? "Write" : "Edit";
		const requiredLevel = getLevelForWrite(withinProject);
		const requiredIndex = AUTONOMY_ORDER.indexOf(requiredLevel);
		const currentIndex = AUTONOMY_ORDER.indexOf(autonomyLevel);

		const options: string[] = ["Allow once"];
		if (requiredIndex > currentIndex) {
			options.push(`Allow all (${AUTONOMY_CONFIGS[requiredLevel].label})`);
		}
		options.push("Block");

		const choice = await ctx.ui.select(
			`📝 ${action} file:\n\n  ${filePath}\n\nCurrent: ${config.label}`,
			options
		);

		if (choice === "Allow once") return undefined;
		if (choice === "Block") return { block: true, reason: "Blocked by user" };

		// Escalate
		if (requiredIndex > currentIndex && choice === `Allow all (${AUTONOMY_CONFIGS[requiredLevel].label})`) {
			autonomyLevel = requiredLevel;
			saveAutonomyLevel(settingsPath, autonomyLevel, gitRoot);
			const scope = isProject ? "project" : "global";
			ctx.ui.notify(`🔓 Autonomy → ${AUTONOMY_CONFIGS[requiredLevel].label} (saved to ${scope})`, "info");
			return undefined;
		}

		return { block: true, reason: "Blocked by user" };
	});
}
