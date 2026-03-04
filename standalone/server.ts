/**
 * Pixel Agents Standalone Server
 *
 * A Bun server that scans ~/.claude/projects/ for JSONL transcript files,
 * parses agent activity, and broadcasts events via WebSocket.
 *
 * Configuration: standalone/.env (see .env for all options)
 * CLI overrides: --port <number> --project <hash> --ssh-host <host>
 */

// Bun type declarations (this file is run with `bun run`, not tsc)
declare const Bun: {
	serve(options: {
		port: number;
		fetch(req: Request, server: { upgrade(req: Request): boolean; port: number }): Response | undefined;
		websocket: {
			open(ws: BunWebSocket): void;
			message(ws: BunWebSocket, message: string | ArrayBuffer): void;
			close(ws: BunWebSocket): void;
		};
	}): { port: number };
};

interface BunWebSocket {
	send(data: string): void;
}

declare global {
	interface ImportMeta {
		dir: string;
	}
}

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PNG } from "pngjs";

// ── .env loading ────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
	const envPath = path.join(import.meta.dir, ".env");
	const env: Record<string, string> = {};
	try {
		const content = fs.readFileSync(envPath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq === -1) continue;
			env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
		}
	} catch { /* no .env file — use defaults */ }
	return env;
}

const dotenv = loadEnv();

function envInt(key: string, fallback: number): number {
	const v = dotenv[key];
	if (v) { const n = parseInt(v, 10); if (!isNaN(n)) return n; }
	return fallback;
}

// ── Constants ──────────────────────────────────────────────────

const SCAN_INTERVAL_MS = 1000;
const TOOL_DONE_DELAY_MS = 300;
const PERMISSION_TIMER_DELAY_MS = 7000;
const TEXT_IDLE_DELAY_MS = 5000;
const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;
const NEW_FILE_THRESHOLD_MS = envInt("NEW_FILE_THRESHOLD_MS", 1_800_000);
const NEW_FILE_THRESHOLD_SHORT_MS = envInt("NEW_FILE_THRESHOLD_SHORT_MS", 180_000);
const INACTIVE_TIMEOUT_MS = envInt("INACTIVE_TIMEOUT_MS", 1_800_000);

const PERMISSION_EXEMPT_TOOLS = new Set(["Task", "AskUserQuestion"]);

/** Projects that spawn many short-lived sessions — use shorter adoption threshold */
const SHORT_THRESHOLD_PROJECTS = new Set(
	(dotenv["SHORT_THRESHOLD_PROJECTS"] || "").split(",").map(s => s.trim()).filter(Boolean)
);

/** Projects to completely exclude from scanning */
const EXCLUDED_PROJECTS = new Set(
	(dotenv["EXCLUDED_PROJECTS"] || "").split(",").map(s => s.trim()).filter(Boolean)
);

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// ── PNG / Asset Constants ───────────────────────────────────────

const PNG_ALPHA_THRESHOLD = 128;
const WALL_PIECE_WIDTH = 16;
const WALL_PIECE_HEIGHT = 32;
const WALL_GRID_COLS = 4;
const WALL_BITMASK_COUNT = 16;
const FLOOR_PATTERN_COUNT = 7;
const FLOOR_TILE_SIZE = 16;
const CHAR_COUNT = 6;
const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;
const CHAR_FRAMES_PER_ROW = 7;
const CHARACTER_DIRECTIONS = ["down", "up", "right"] as const;

// ── Types ──────────────────────────────────────────────────────

interface RecentEvent {
	type: 'toolStart' | 'toolDone' | 'status';
	toolId?: string;
	toolName?: string;
	status?: string;
	agentStatus?: string;
	timestamp: number;
	filePath?: string;
}

interface AgentState {
	id: number;
	jsonlFile: string;
	projectDir: string;
	fileOffset: number;
	lineBuffer: string;
	activeToolIds: Set<string>;
	activeToolStatuses: Map<string, string>;
	activeToolNames: Map<string, string>;
	activeSubagentToolIds: Map<string, Set<string>>;
	activeSubagentToolNames: Map<string, Map<string, string>>;
	isWaiting: boolean;
	permissionSent: boolean;
	hadToolsInTurn: boolean;
	folderName: string;
	projectPath: string;
	recentEvents: RecentEvent[];
}

interface WsMessage {
	type: string;
	[key: string]: unknown;
}

// ── Asset Types ────────────────────────────────────────────────

interface FurnitureAsset {
	id: string;
	name: string;
	label: string;
	category: string;
	file: string;
	width: number;
	height: number;
	footprintW: number;
	footprintH: number;
	isDesk: boolean;
	canPlaceOnWalls: boolean;
	partOfGroup?: boolean;
	groupId?: string;
	canPlaceOnSurfaces?: boolean;
	backgroundTiles?: number;
	orientation?: string;
	state?: string;
	isSocialSpot?: boolean;
}

interface CharacterDirectionSprites {
	down: string[][][];
	up: string[][][];
	right: string[][][];
}

interface LoadedAssets {
	characters: CharacterDirectionSprites[];
	floorTiles: string[][][];
	wallTiles: string[][][];
	furniture: {
		catalog: FurnitureAsset[];
		sprites: Record<string, string[][]>;
	};
	layout: Record<string, unknown> | null;
}

// ── CLI Argument Parsing ───────────────────────────────────────

function parseArgs(): { port: number; projectFilter: string | null; sshHost: string | null } {
	const args = process.argv.slice(2);
	let port = envInt("PORT", 4242);
	let projectFilter: string | null = dotenv["PROJECT_FILTER"] || null;
	let sshHost: string | null = dotenv["SSH_HOST"] || null;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--port" && args[i + 1]) {
			port = parseInt(args[i + 1], 10);
			if (isNaN(port) || port < 1 || port > 65535) {
				console.error(`Invalid port: ${args[i + 1]}`);
				process.exit(1);
			}
			i++;
		} else if (args[i] === "--project" && args[i + 1]) {
			projectFilter = args[i + 1];
			i++;
		} else if (args[i] === "--ssh-host" && args[i + 1]) {
			sshHost = args[i + 1];
			i++;
		}
	}

	return { port, projectFilter, sshHost };
}

/** Reconstruct absolute path from Claude project hash (e.g. -home-user-projects-foo → /home/user/projects/foo) */
function hashToPath(projectDir: string): string {
	const hash = path.basename(projectDir);
	const parts = hash.replace(/^-/, "").split("-");

	// DFS: at each part, try extending current segment with "-" or starting new "/" segment
	// Validate against filesystem to resolve ambiguity
	function solve(idx: number, current: string): string | null {
		if (idx === parts.length) {
			return fs.existsSync(current) ? current : null;
		}
		// Option 1: start new path segment (/)
		const withSlash = current + "/" + parts[idx];
		const r1 = solve(idx + 1, withSlash);
		if (r1) return r1;
		// Option 2: extend current segment with dash (-)
		if (current !== "") {
			const withDash = current + "-" + parts[idx];
			const r2 = solve(idx + 1, withDash);
			if (r2) return r2;
		}
		return null;
	}

	return solve(1, "/" + parts[0]) || "/" + parts.join("/");
}

// ── Global State ───────────────────────────────────────────────

const agents = new Map<number, AgentState>();
const knownJsonlFiles = new Set<string>();
const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
const wsClients = new Set<BunWebSocket>();
let nextAgentId = 1;

// ── WebSocket Broadcasting ─────────────────────────────────────

function broadcast(msg: WsMessage): void {
	const data = JSON.stringify(msg);
	for (const ws of wsClients) {
		try {
			ws.send(data);
		} catch {
			// Client may have disconnected
		}
	}
}

// ── Recent Event Buffer ────────────────────────────────────────

const MAX_RECENT_EVENTS = 50;

function pushRecentEvent(agent: AgentState, event: RecentEvent): void {
	agent.recentEvents.push(event);
	if (agent.recentEvents.length > MAX_RECENT_EVENTS) {
		agent.recentEvents.shift();
	}
}

// ── Tool Status Formatting ─────────────────────────────────────

function formatToolStatus(
	toolName: string,
	input: Record<string, unknown>,
): string {
	const base = (p: unknown) => (typeof p === "string" ? path.basename(p) : "");
	switch (toolName) {
		case "Read":
			return `Reading ${base(input.file_path)}`;
		case "Edit":
			return `Editing ${base(input.file_path)}`;
		case "Write":
			return `Writing ${base(input.file_path)}`;
		case "Bash": {
			const cmd = (input.command as string) || "";
			return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + "\u2026" : cmd}`;
		}
		case "Glob":
			return "Searching files";
		case "Grep":
			return "Searching code";
		case "WebFetch":
			return "Fetching web content";
		case "WebSearch":
			return "Searching the web";
		case "Task": {
			const desc =
				typeof input.description === "string" ? input.description : "";
			return desc
				? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + "\u2026" : desc}`
				: "Running subtask";
		}
		case "AskUserQuestion":
			return "Waiting for your answer";
		case "EnterPlanMode":
			return "Planning";
		case "NotebookEdit":
			return "Editing notebook";
		default:
			return `Using ${toolName}`;
	}
}

// ── Folder Name Extraction ─────────────────────────────────────

function extractFolderName(projectDir: string): string {
	const hash = path.basename(projectDir);
	const match = hash.match(/-projects-(.+)$/);
	if (match) return match[1];
	const parts = hash.replace(/^-/, "").split("-");
	return parts.length > 2
		? parts.slice(2).join("-")
		: parts[parts.length - 1] || hash;
}

// ── Timer Management ───────────────────────────────────────────

function cancelWaitingTimer(agentId: number): void {
	const timer = waitingTimers.get(agentId);
	if (timer) {
		clearTimeout(timer);
		waitingTimers.delete(agentId);
	}
}

function startWaitingTimer(agentId: number): void {
	cancelWaitingTimer(agentId);
	const timer = setTimeout(() => {
		waitingTimers.delete(agentId);
		const agent = agents.get(agentId);
		if (agent) {
			agent.isWaiting = true;
		}
		const waitingTimestamp = Date.now();
		broadcast({ type: "agentStatus", id: agentId, status: "waiting", timestamp: waitingTimestamp });
		if (agent) {
			pushRecentEvent(agent, { type: 'status', agentStatus: 'waiting', timestamp: waitingTimestamp });
		}
	}, TEXT_IDLE_DELAY_MS);
	waitingTimers.set(agentId, timer);
}

function cancelPermissionTimer(agentId: number): void {
	const timer = permissionTimers.get(agentId);
	if (timer) {
		clearTimeout(timer);
		permissionTimers.delete(agentId);
	}
}

function startPermissionTimer(agentId: number): void {
	cancelPermissionTimer(agentId);
	const timer = setTimeout(() => {
		permissionTimers.delete(agentId);
		const agent = agents.get(agentId);
		if (!agent) return;

		// Only flag if there are still active non-exempt tools (parent or sub-agent)
		let hasNonExempt = false;
		for (const toolId of agent.activeToolIds) {
			const toolName = agent.activeToolNames.get(toolId);
			if (!PERMISSION_EXEMPT_TOOLS.has(toolName || "")) {
				hasNonExempt = true;
				break;
			}
		}

		// Check sub-agent tools for non-exempt tools
		const stuckSubagentParentToolIds: string[] = [];
		for (const [parentToolId, subToolNames] of agent.activeSubagentToolNames) {
			for (const [, toolName] of subToolNames) {
				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					stuckSubagentParentToolIds.push(parentToolId);
					hasNonExempt = true;
					break;
				}
			}
		}

		if (hasNonExempt) {
			agent.permissionSent = true;
			console.log(
				`[Server] Agent ${agentId}: possible permission wait detected`,
			);
			broadcast({ type: "agentToolPermission", id: agentId });
			// Also notify stuck sub-agents
			for (const parentToolId of stuckSubagentParentToolIds) {
				broadcast({
					type: "subagentToolPermission",
					id: agentId,
					parentToolId,
				});
			}
		}
	}, PERMISSION_TIMER_DELAY_MS);
	permissionTimers.set(agentId, timer);
}

function clearAgentActivity(agent: AgentState): void {
	agent.activeToolIds.clear();
	agent.activeToolStatuses.clear();
	agent.activeToolNames.clear();
	agent.activeSubagentToolIds.clear();
	agent.activeSubagentToolNames.clear();
	agent.isWaiting = false;
	agent.permissionSent = false;
	cancelPermissionTimer(agent.id);
	broadcast({ type: "agentToolsClear", id: agent.id });
	const clearActiveTimestamp = Date.now();
	broadcast({ type: "agentStatus", id: agent.id, status: "active" });
	pushRecentEvent(agent, { type: 'status', agentStatus: 'active', timestamp: clearActiveTimestamp });
}

// ── JSONL Parsing ──────────────────────────────────────────────

function processTranscriptLine(agentId: number, line: string): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	try {
		const record = JSON.parse(line);

		if (
			record.type === "assistant" &&
			Array.isArray(record.message?.content)
		) {
			const blocks = record.message.content as Array<{
				type: string;
				id?: string;
				name?: string;
				input?: Record<string, unknown>;
			}>;
			const hasToolUse = blocks.some(
				(b: { type: string }) => b.type === "tool_use",
			);

			if (hasToolUse) {
				cancelWaitingTimer(agentId);
				agent.isWaiting = false;
				agent.hadToolsInTurn = true;
				const activeTimestamp = Date.now();
				broadcast({ type: "agentStatus", id: agentId, status: "active", timestamp: activeTimestamp });
				pushRecentEvent(agent, { type: 'status', agentStatus: 'active', timestamp: activeTimestamp });
				let hasNonExemptTool = false;
				for (const block of blocks) {
					if (block.type === "tool_use" && block.id) {
						const toolName = block.name || "";
						const status = formatToolStatus(
							toolName,
							block.input || {},
						);
						const inp = block.input || {};
						const filePath = (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') && typeof inp.file_path === 'string'
							? inp.file_path as string
							: undefined;
						console.log(
							`[Server] Agent ${agentId} tool start: ${block.id} ${status}`,
						);
						agent.activeToolIds.add(block.id);
						agent.activeToolStatuses.set(block.id, status);
						agent.activeToolNames.set(block.id, toolName);
						if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
							hasNonExemptTool = true;
						}
						const toolStartTimestamp = Date.now();
						broadcast({
							type: "agentToolStart",
							id: agentId,
							toolId: block.id,
							status,
							toolName,
							timestamp: toolStartTimestamp,
							filePath,
						});
						pushRecentEvent(agent, { type: 'toolStart', toolId: block.id, toolName, status, timestamp: toolStartTimestamp, filePath });
					}
				}
				if (hasNonExemptTool) {
					startPermissionTimer(agentId);
				}
			} else if (
				blocks.some((b: { type: string }) => b.type === "text") &&
				!agent.hadToolsInTurn
			) {
				startWaitingTimer(agentId);
			}
		} else if (record.type === "progress") {
			processProgressRecord(agentId, record);
		} else if (record.type === "user") {
			const content = record.message?.content;
			if (Array.isArray(content)) {
				const blocks = content as Array<{
					type: string;
					tool_use_id?: string;
				}>;
				const hasToolResult = blocks.some(
					(b: { type: string }) => b.type === "tool_result",
				);
				if (hasToolResult) {
					for (const block of blocks) {
						if (block.type === "tool_result" && block.tool_use_id) {
							console.log(
								`[Server] Agent ${agentId} tool done: ${block.tool_use_id}`,
							);
							const completedToolId = block.tool_use_id;
							// If the completed tool was a Task, clear its subagent tools
							if (
								agent.activeToolNames.get(completedToolId) ===
								"Task"
							) {
								agent.activeSubagentToolIds.delete(
									completedToolId,
								);
								agent.activeSubagentToolNames.delete(
									completedToolId,
								);
								broadcast({
									type: "subagentClear",
									id: agentId,
									parentToolId: completedToolId,
								});
							}
							agent.activeToolIds.delete(completedToolId);
							agent.activeToolStatuses.delete(completedToolId);
							agent.activeToolNames.delete(completedToolId);
							const toolId = completedToolId;
							setTimeout(() => {
								const toolDoneTimestamp = Date.now();
								broadcast({
									type: "agentToolDone",
									id: agentId,
									toolId,
									timestamp: toolDoneTimestamp,
								});
								const agentForEvent = agents.get(agentId);
								if (agentForEvent) {
									pushRecentEvent(agentForEvent, { type: 'toolDone', toolId, timestamp: toolDoneTimestamp });
								}
							}, TOOL_DONE_DELAY_MS);
						}
					}
					// All tools completed -- allow text-idle timer as fallback
					if (agent.activeToolIds.size === 0) {
						agent.hadToolsInTurn = false;
					}
				} else {
					// New user text prompt (array content but no tool_result) -- new turn starting
					cancelWaitingTimer(agentId);
					clearAgentActivity(agent);
					agent.hadToolsInTurn = false;
				}
			} else if (typeof content === "string" && content.trim()) {
				// New user text prompt -- new turn starting
				cancelWaitingTimer(agentId);
				clearAgentActivity(agent);
				agent.hadToolsInTurn = false;
			}
		} else if (
			record.type === "system" &&
			record.subtype === "turn_duration"
		) {
			cancelWaitingTimer(agentId);
			cancelPermissionTimer(agentId);

			// Definitive turn-end: clean up any stale tool state
			if (agent.activeToolIds.size > 0) {
				agent.activeToolIds.clear();
				agent.activeToolStatuses.clear();
				agent.activeToolNames.clear();
				agent.activeSubagentToolIds.clear();
				agent.activeSubagentToolNames.clear();
				broadcast({ type: "agentToolsClear", id: agentId });
			}

			agent.isWaiting = true;
			agent.permissionSent = false;
			agent.hadToolsInTurn = false;
			const turnDoneTimestamp = Date.now();
			broadcast({ type: "agentStatus", id: agentId, status: "waiting", timestamp: turnDoneTimestamp });
			pushRecentEvent(agent, { type: 'status', agentStatus: 'waiting', timestamp: turnDoneTimestamp });
		}
	} catch {
		// Ignore malformed lines
	}
}

function processProgressRecord(
	agentId: number,
	record: Record<string, unknown>,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	const parentToolId = record.parentToolUseID as string | undefined;
	if (!parentToolId) return;

	const data = record.data as Record<string, unknown> | undefined;
	if (!data) return;

	// bash_progress / mcp_progress: tool is actively executing, not stuck on permission.
	const dataType = data.type as string | undefined;
	if (dataType === "bash_progress" || dataType === "mcp_progress") {
		if (agent.activeToolIds.has(parentToolId)) {
			startPermissionTimer(agentId);
		}
		return;
	}

	// Verify parent is an active Task tool (agent_progress handling)
	if (agent.activeToolNames.get(parentToolId) !== "Task") return;

	const msg = data.message as Record<string, unknown> | undefined;
	if (!msg) return;

	const msgType = msg.type as string;
	const innerMsg = msg.message as Record<string, unknown> | undefined;
	const content = innerMsg?.content;
	if (!Array.isArray(content)) return;

	if (msgType === "assistant") {
		let hasNonExemptSubTool = false;
		for (const block of content) {
			if (block.type === "tool_use" && block.id) {
				const toolName = block.name || "";
				const status = formatToolStatus(toolName, block.input || {});
				console.log(
					`[Server] Agent ${agentId} subagent tool start: ${block.id} ${status} (parent: ${parentToolId})`,
				);

				// Track sub-tool IDs
				let subTools = agent.activeSubagentToolIds.get(parentToolId);
				if (!subTools) {
					subTools = new Set();
					agent.activeSubagentToolIds.set(parentToolId, subTools);
				}
				subTools.add(block.id);

				// Track sub-tool names (for permission checking)
				let subNames = agent.activeSubagentToolNames.get(parentToolId);
				if (!subNames) {
					subNames = new Map();
					agent.activeSubagentToolNames.set(parentToolId, subNames);
				}
				subNames.set(block.id, toolName);

				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					hasNonExemptSubTool = true;
				}

				broadcast({
					type: "subagentToolStart",
					id: agentId,
					parentToolId,
					toolId: block.id,
					status,
				});
			}
		}
		if (hasNonExemptSubTool) {
			startPermissionTimer(agentId);
		}
	} else if (msgType === "user") {
		for (const block of content) {
			if (block.type === "tool_result" && block.tool_use_id) {
				console.log(
					`[Server] Agent ${agentId} subagent tool done: ${block.tool_use_id} (parent: ${parentToolId})`,
				);

				// Remove from tracking
				const subTools =
					agent.activeSubagentToolIds.get(parentToolId);
				if (subTools) {
					subTools.delete(block.tool_use_id);
				}
				const subNames =
					agent.activeSubagentToolNames.get(parentToolId);
				if (subNames) {
					subNames.delete(block.tool_use_id);
				}

				const toolId = block.tool_use_id;
				setTimeout(() => {
					broadcast({
						type: "subagentToolDone",
						id: agentId,
						parentToolId,
						toolId,
					});
				}, TOOL_DONE_DELAY_MS);
			}
		}
		// If there are still active non-exempt sub-agent tools, restart the permission timer
		let stillHasNonExempt = false;
		for (const [, subNames] of agent.activeSubagentToolNames) {
			for (const [, toolName] of subNames) {
				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					stillHasNonExempt = true;
					break;
				}
			}
			if (stillHasNonExempt) break;
		}
		if (stillHasNonExempt) {
			startPermissionTimer(agentId);
		}
	}
}

// ── File Reading ───────────────────────────────────────────────

function readNewLines(agentId: number): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	try {
		const stat = fs.statSync(agent.jsonlFile);
		if (stat.size <= agent.fileOffset) return;

		const buf = Buffer.alloc(stat.size - agent.fileOffset);
		const fd = fs.openSync(agent.jsonlFile, "r");
		fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
		fs.closeSync(fd);
		agent.fileOffset = stat.size;

		const text = agent.lineBuffer + buf.toString("utf-8");
		const lines = text.split("\n");
		agent.lineBuffer = lines.pop() || "";

		const hasLines = lines.some((l) => l.trim());
		if (hasLines) {
			// New data arriving -- cancel timers (data flowing means agent is still active)
			cancelWaitingTimer(agentId);
			cancelPermissionTimer(agentId);
			if (agent.permissionSent) {
				agent.permissionSent = false;
				broadcast({ type: "agentToolPermissionClear", id: agentId });
			}
		}

		for (const line of lines) {
			if (!line.trim()) continue;
			processTranscriptLine(agentId, line);
		}
	} catch (e) {
		console.log(`[Server] Read error for agent ${agentId}: ${e}`);
	}
}

// ── Agent Lifecycle ────────────────────────────────────────────

function createAgent(jsonlFile: string, projectDir: string): AgentState {
	const id = nextAgentId++;
	const folderName = extractFolderName(projectDir);
	const projectPath = hashToPath(projectDir);

	const agent: AgentState = {
		id,
		jsonlFile,
		projectDir,
		fileOffset: 0,
		lineBuffer: "",
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: true,  // Assumed idle until activity detected
		permissionSent: false,
		hadToolsInTurn: false,
		folderName,
		projectPath,
		recentEvents: [],
	};

	// Start from current file size (skip history)
	try {
		const stat = fs.statSync(jsonlFile);
		agent.fileOffset = stat.size;
	} catch {
		// File may not be readable yet
	}

	agents.set(id, agent);
	knownJsonlFiles.add(jsonlFile);

	console.log(
		`[Server] Agent ${id}: created for ${path.basename(jsonlFile)} (${folderName})`,
	);
	broadcast({
		type: "agentCreated",
		id,
		folderName,
		projectPath,
		timestamp: Date.now(),
	});

	return agent;
}

function removeAgent(agentId: number): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	cancelWaitingTimer(agentId);
	cancelPermissionTimer(agentId);
	knownJsonlFiles.delete(agent.jsonlFile);
	agents.delete(agentId);

	console.log(`[Server] Agent ${agentId}: removed (inactive)`);
	broadcast({ type: "agentClosed", id: agentId });
}

// ── Scanning ───────────────────────────────────────────────────

function getProjectDirs(projectFilter: string | null): string[] {
	const dirs: string[] = [];
	try {
		const entries = fs.readdirSync(CLAUDE_PROJECTS_DIR);
		for (const entry of entries) {
			if (projectFilter && entry !== projectFilter) continue;
			const fullPath = path.join(CLAUDE_PROJECTS_DIR, entry);
			try {
				if (fs.statSync(fullPath).isDirectory()) {
					dirs.push(fullPath);
				}
			} catch {
				// Skip inaccessible dirs
			}
		}
	} catch {
		// ~/.claude/projects/ may not exist
	}
	return dirs;
}

function scanForAgents(projectFilter: string | null): void {
	const projectDirs = getProjectDirs(projectFilter);
	const now = Date.now();

	for (const projectDir of projectDirs) {
		const projName = extractFolderName(projectDir);
		if (EXCLUDED_PROJECTS.has(projName)) continue;

		let files: string[];
		try {
			files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}

		for (const file of files) {
			const fullPath = path.join(projectDir, file);

			// Already tracked?
			let tracked = false;
			for (const agent of agents.values()) {
				if (agent.jsonlFile === fullPath) {
					tracked = true;
					break;
				}
			}

			if (!tracked) {
				// New file: adopt if recently active and non-empty
				try {
					const stat = fs.statSync(fullPath);
					const ageMs = now - stat.mtimeMs;
					const folderName = extractFolderName(projectDir);
					const threshold = SHORT_THRESHOLD_PROJECTS.has(folderName) ? NEW_FILE_THRESHOLD_SHORT_MS : NEW_FILE_THRESHOLD_MS;
					if (stat.size > 0 && ageMs < threshold) {
						createAgent(fullPath, projectDir);
					}
				} catch {
					// Skip unreadable files
				}
			}
		}
	}

	// Read new lines from all tracked agents
	for (const agent of agents.values()) {
		readNewLines(agent.id);
	}

	// Cleanup: remove agents whose JSONL files have been inactive too long
	const toRemove: number[] = [];
	for (const [agentId, agent] of agents) {
		try {
			const stat = fs.statSync(agent.jsonlFile);
			const idleMs = now - stat.mtimeMs;
			const timeout = SHORT_THRESHOLD_PROJECTS.has(agent.folderName) ? NEW_FILE_THRESHOLD_SHORT_MS : INACTIVE_TIMEOUT_MS;
			if (idleMs > timeout) {
				toRemove.push(agentId);
			}
		} catch {
			// File deleted or inaccessible -- remove the agent
			toRemove.push(agentId);
		}
	}
	for (const agentId of toRemove) {
		removeAgent(agentId);
	}
}

// ── PNG / Asset Loading ────────────────────────────────────────

let cachedAssets: LoadedAssets | null = null;

/**
 * Convert PNG buffer to SpriteData (2D array of hex color strings).
 * Transparent pixels = '', opaque = '#RRGGBB'.
 */
function pngToSpriteData(
	pngBuffer: Buffer,
	width: number,
	height: number,
): string[][] {
	try {
		const png = PNG.sync.read(pngBuffer);

		if (png.width !== width || png.height !== height) {
			console.log(
				`[Server] PNG dimensions mismatch: expected ${width}x${height}, got ${png.width}x${png.height}`,
			);
		}

		const sprite: string[][] = [];
		const data = png.data;

		for (let y = 0; y < height; y++) {
			const row: string[] = [];
			for (let x = 0; x < width; x++) {
				const pixelIndex = (y * png.width + x) * 4;
				const r = data[pixelIndex];
				const g = data[pixelIndex + 1];
				const b = data[pixelIndex + 2];
				const a = data[pixelIndex + 3];

				if (a < PNG_ALPHA_THRESHOLD) {
					row.push("");
				} else {
					const hex =
						`#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase();
					row.push(hex);
				}
			}
			sprite.push(row);
		}

		return sprite;
	} catch (err) {
		console.log(
			`[Server] Failed to parse PNG: ${err instanceof Error ? err.message : err}`,
		);
		// Return transparent placeholder
		const sprite: string[][] = [];
		for (let y = 0; y < height; y++) {
			sprite.push(new Array(width).fill(""));
		}
		return sprite;
	}
}

/**
 * Load all assets from the given root directory.
 * assetsRoot is the directory containing the 'assets/' folder.
 */
function loadAllAssets(assetsRoot: string): LoadedAssets {
	// ── Character sprites ──────────────────────────────────
	const characters: CharacterDirectionSprites[] = [];
	const charDir = path.join(assetsRoot, "assets", "characters");

	for (let ci = 0; ci < CHAR_COUNT; ci++) {
		const filePath = path.join(charDir, `char_${ci}.png`);
		if (!fs.existsSync(filePath)) {
			console.log(
				`[Server] Character sprite not found: ${filePath}`,
			);
			break;
		}

		const pngBuffer = fs.readFileSync(filePath);
		const png = PNG.sync.read(pngBuffer);
		const charData: CharacterDirectionSprites = {
			down: [],
			up: [],
			right: [],
		};

		for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx++) {
			const dir = CHARACTER_DIRECTIONS[dirIdx];
			const rowOffsetY = dirIdx * CHAR_FRAME_H;
			const frames: string[][][] = [];

			for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
				const sprite: string[][] = [];
				const frameOffsetX = f * CHAR_FRAME_W;
				for (let y = 0; y < CHAR_FRAME_H; y++) {
					const row: string[] = [];
					for (let x = 0; x < CHAR_FRAME_W; x++) {
						const idx =
							((rowOffsetY + y) * png.width +
								(frameOffsetX + x)) *
							4;
						const r = png.data[idx];
						const g = png.data[idx + 1];
						const b = png.data[idx + 2];
						const a = png.data[idx + 3];
						if (a < PNG_ALPHA_THRESHOLD) {
							row.push("");
						} else {
							row.push(
								`#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase(),
							);
						}
					}
					sprite.push(row);
				}
				frames.push(sprite);
			}
			charData[dir] = frames;
		}
		characters.push(charData);
	}
	console.log(
		`[Server] Loaded ${characters.length} character sprites (${CHAR_FRAMES_PER_ROW} frames x 3 directions each)`,
	);

	// ── Floor tiles ────────────────────────────────────────
	let floorTiles: string[][][] = [];
	const floorPath = path.join(assetsRoot, "assets", "floors.png");

	if (fs.existsSync(floorPath)) {
		const pngBuffer = fs.readFileSync(floorPath);
		const png = PNG.sync.read(pngBuffer);

		for (let t = 0; t < FLOOR_PATTERN_COUNT; t++) {
			const sprite: string[][] = [];
			for (let y = 0; y < FLOOR_TILE_SIZE; y++) {
				const row: string[] = [];
				for (let x = 0; x < FLOOR_TILE_SIZE; x++) {
					const px = t * FLOOR_TILE_SIZE + x;
					const idx = (y * png.width + px) * 4;
					const r = png.data[idx];
					const g = png.data[idx + 1];
					const b = png.data[idx + 2];
					const a = png.data[idx + 3];
					if (a < PNG_ALPHA_THRESHOLD) {
						row.push("");
					} else {
						row.push(
							`#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase(),
						);
					}
				}
				sprite.push(row);
			}
			floorTiles.push(sprite);
		}
		console.log(
			`[Server] Loaded ${floorTiles.length} floor tile patterns`,
		);
	} else {
		console.log(`[Server] No floors.png found at: ${floorPath}`);
	}

	// ── Wall tiles ─────────────────────────────────────────
	let wallTiles: string[][][] = [];
	const wallPath = path.join(assetsRoot, "assets", "walls.png");

	if (fs.existsSync(wallPath)) {
		const pngBuffer = fs.readFileSync(wallPath);
		const png = PNG.sync.read(pngBuffer);

		for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
			const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
			const oy =
				Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
			const sprite: string[][] = [];
			for (let r = 0; r < WALL_PIECE_HEIGHT; r++) {
				const row: string[] = [];
				for (let c = 0; c < WALL_PIECE_WIDTH; c++) {
					const idx =
						((oy + r) * png.width + (ox + c)) * 4;
					const rv = png.data[idx];
					const gv = png.data[idx + 1];
					const bv = png.data[idx + 2];
					const av = png.data[idx + 3];
					if (av < PNG_ALPHA_THRESHOLD) {
						row.push("");
					} else {
						row.push(
							`#${rv.toString(16).padStart(2, "0")}${gv.toString(16).padStart(2, "0")}${bv.toString(16).padStart(2, "0")}`.toUpperCase(),
						);
					}
				}
				sprite.push(row);
			}
			wallTiles.push(sprite);
		}
		console.log(
			`[Server] Loaded ${wallTiles.length} wall tile pieces`,
		);
	} else {
		console.log(`[Server] No walls.png found at: ${wallPath}`);
	}

	// ── Furniture ──────────────────────────────────────────
	let catalog: FurnitureAsset[] = [];
	const sprites: Record<string, string[][]> = {};
	const catalogPath = path.join(
		assetsRoot,
		"assets",
		"furniture",
		"furniture-catalog.json",
	);

	if (fs.existsSync(catalogPath)) {
		const catalogContent = fs.readFileSync(catalogPath, "utf-8");
		const catalogData = JSON.parse(catalogContent);
		catalog = catalogData.assets || [];

		for (const asset of catalog) {
			try {
				let filePath = asset.file;
				if (!filePath.startsWith("assets/")) {
					filePath = `assets/${filePath}`;
				}
				const assetPath = path.join(assetsRoot, filePath);

				if (!fs.existsSync(assetPath)) {
					console.log(
						`[Server] Furniture asset not found: ${asset.file}`,
					);
					continue;
				}

				const pngBuffer = fs.readFileSync(assetPath);
				const spriteData = pngToSpriteData(
					pngBuffer,
					asset.width,
					asset.height,
				);
				sprites[asset.id] = spriteData;
			} catch (err) {
				console.log(
					`[Server] Error loading furniture ${asset.id}: ${err instanceof Error ? err.message : err}`,
				);
			}
		}
		console.log(
			`[Server] Loaded ${Object.keys(sprites).length} / ${catalog.length} furniture sprites`,
		);
	} else {
		console.log(
			`[Server] No furniture-catalog.json found at: ${catalogPath}`,
		);
	}

	// ── Layout ─────────────────────────────────────────────
	let layout: Record<string, unknown> | null = null;
	const userLayoutPath = path.join(
		os.homedir(),
		".pixel-agents",
		"layout.json",
	);
	const defaultLayoutPath = path.join(
		assetsRoot,
		"assets",
		"default-layout.json",
	);

	if (fs.existsSync(userLayoutPath)) {
		try {
			const content = fs.readFileSync(userLayoutPath, "utf-8");
			layout = JSON.parse(content) as Record<string, unknown>;
			console.log(
				`[Server] Loaded user layout from ${userLayoutPath} (${layout.cols}x${layout.rows})`,
			);
		} catch (err) {
			console.log(
				`[Server] Error reading user layout: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	if (!layout && fs.existsSync(defaultLayoutPath)) {
		try {
			const content = fs.readFileSync(defaultLayoutPath, "utf-8");
			layout = JSON.parse(content) as Record<string, unknown>;
			console.log(
				`[Server] Loaded default layout (${layout.cols}x${layout.rows})`,
			);
		} catch (err) {
			console.log(
				`[Server] Error reading default layout: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	if (!layout) {
		console.log("[Server] No layout found (user or default)");
	}

	return {
		characters,
		floorTiles,
		wallTiles,
		furniture: { catalog, sprites },
		layout,
	};
}

/**
 * Initialize assets at server startup.
 * Loads all PNG assets from the webview-ui/public directory and caches them.
 */
function initAssets(): void {
	const assetsRoot = path.join(
		path.resolve(import.meta.dir, ".."),
		"webview-ui",
		"public",
	);
	console.log(`[Server] Loading assets from: ${assetsRoot}`);
	cachedAssets = loadAllAssets(assetsRoot);
	console.log("[Server] Asset loading complete");
}

// ── HTTP Server ────────────────────────────────────────────────

const WEBVIEW_DIR = path.join(import.meta.dir, '..', 'dist', 'webview');

const MIME_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
};

function startServer(port: number, projectFilter: string | null): void {
	const server = Bun.serve({
		port,
		fetch(req, server) {
			const url = new URL(req.url);

			// WebSocket upgrade
			if (url.pathname === "/ws") {
				const upgraded = server.upgrade(req);
				if (!upgraded) {
					return new Response("WebSocket upgrade failed", {
						status: 400,
					});
				}
				return undefined as unknown as Response;
			}

			// Static file serving from dist/webview/
			let filePath: string;
			if (url.pathname === "/") {
				filePath = path.join(WEBVIEW_DIR, "index.html");
			} else {
				filePath = path.join(WEBVIEW_DIR, url.pathname);
			}

			// Security: prevent directory traversal
			const resolved = path.resolve(filePath);
			if (!resolved.startsWith(path.resolve(WEBVIEW_DIR))) {
				return new Response("Forbidden", { status: 403 });
			}

			try {
				if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
					const content = fs.readFileSync(resolved);
					const ext = path.extname(resolved).toLowerCase();
					const contentType = MIME_TYPES[ext] || 'application/octet-stream';
					return new Response(content, {
						headers: { 'Content-Type': contentType },
					});
				}
			} catch {
				// Fall through to SPA fallback
			}

			// SPA fallback: serve index.html
			try {
				const indexHtml = fs.readFileSync(path.join(WEBVIEW_DIR, "index.html"));
				return new Response(indexHtml, {
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				});
			} catch {
				return new Response("index.html not found", { status: 404 });
			}
		},
		websocket: {
			open(ws) {
				wsClients.add(ws);
				console.log(
					`[Server] WebSocket client connected (${wsClients.size} total)`,
				);

				if (!cachedAssets) return;

				// 1. Settings
				ws.send(JSON.stringify({ type: 'settingsLoaded', soundEnabled: true, sshHost }));

				// 2. Character sprites
				ws.send(JSON.stringify({
					type: 'characterSpritesLoaded',
					characters: cachedAssets.characters,
				}));

				// 3. Floor tiles
				ws.send(JSON.stringify({
					type: 'floorTilesLoaded',
					sprites: cachedAssets.floorTiles,
				}));

				// 4. Wall tiles
				ws.send(JSON.stringify({
					type: 'wallTilesLoaded',
					sprites: cachedAssets.wallTiles,
				}));

				// 5. Furniture
				ws.send(JSON.stringify({
					type: 'furnitureAssetsLoaded',
					catalog: cachedAssets.furniture.catalog,
					sprites: cachedAssets.furniture.sprites,
				}));

				// 6. Existing agents (extension format)
				const agentIds: number[] = [];
				const agentMeta: Record<number, { isIdle: boolean }> = {};
				const folderNames: Record<number, string> = {};
				const projectPaths: Record<number, string> = {};
				for (const agent of agents.values()) {
					agentIds.push(agent.id);
					agentMeta[agent.id] = { isIdle: agent.isWaiting };
					folderNames[agent.id] = agent.folderName;
					projectPaths[agent.id] = agent.projectPath;
				}
				ws.send(JSON.stringify({
					type: 'existingAgents',
					agents: agentIds,
					agentMeta,
					folderNames,
					projectPaths,
				}));

				// 7. Layout
				ws.send(JSON.stringify({
					type: 'layoutLoaded',
					layout: cachedAssets.layout,
				}));

				// 8. Recent event history per agent
				const agentRecentHistory: Record<number, RecentEvent[]> = {};
				for (const agent of agents.values()) {
					if (agent.recentEvents.length > 0) {
						agentRecentHistory[agent.id] = agent.recentEvents;
					}
				}
				if (Object.keys(agentRecentHistory).length > 0) {
					ws.send(JSON.stringify({ type: 'agentRecentHistory', history: agentRecentHistory }));
				}
			},
			message(ws, message) {
				try {
					const msg = JSON.parse(String(message));
					if (msg.type === 'webviewReady') {
						console.log('[Server] Received webviewReady from client');
					} else if (msg.type === 'saveLayout' && msg.layout) {
						const layoutDir = path.join(os.homedir(), ".pixel-agents");
						const layoutPath = path.join(layoutDir, "layout.json");
						const tmpPath = layoutPath + ".tmp";
						try {
							if (!fs.existsSync(layoutDir)) fs.mkdirSync(layoutDir, { recursive: true });
							fs.writeFileSync(tmpPath, JSON.stringify(msg.layout, null, 2), "utf-8");
							fs.renameSync(tmpPath, layoutPath);
							cachedAssets.layout = msg.layout;
							console.log('[Server] Layout saved to', layoutPath);
						} catch (err) {
							console.error('[Server] Failed to save layout:', err);
						}
					}
				} catch { /* ignore */ }
			},
			close(ws) {
				wsClients.delete(ws);
				console.log(
					`[Server] WebSocket client disconnected (${wsClients.size} total)`,
				);
			},
		},
	});

	console.log(`[Server] Pixel Agents standalone server running on http://localhost:${server.port}`);
	console.log(
		`[Server] Scanning: ${projectFilter ? `project "${projectFilter}"` : "all projects"} in ${CLAUDE_PROJECTS_DIR}`,
	);
	console.log(`[Server] WebSocket endpoint: ws://localhost:${server.port}/ws`);

	// Start scanning
	setInterval(() => {
		scanForAgents(projectFilter);
	}, SCAN_INTERVAL_MS);

	// Run an initial scan immediately
	scanForAgents(projectFilter);
}

// ── Entry Point ────────────────────────────────────────────────

const { port, projectFilter, sshHost } = parseArgs();
initAssets();
startServer(port, projectFilter);
