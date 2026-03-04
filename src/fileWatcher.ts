import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentState } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer, clearAgentActivity } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import { FILE_WATCHER_POLL_INTERVAL_MS, PROJECT_SCAN_INTERVAL_MS, AGENT_INACTIVE_TIMEOUT_MS } from './constants.js';


export function startFileWatching(
	agentId: number,
	filePath: string,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	// Primary: fs.watch (unreliable on macOS — may miss events)
	try {
		const watcher = fs.watch(filePath, () => {
			readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
		});
		fileWatchers.set(agentId, watcher);
	} catch (e) {
		console.log(`[Pixel Agents] fs.watch failed for agent ${agentId}: ${e}`);
	}

	// Secondary: fs.watchFile (stat-based polling, reliable on macOS)
	try {
		fs.watchFile(filePath, { interval: FILE_WATCHER_POLL_INTERVAL_MS }, () => {
			readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
		});
	} catch (e) {
		console.log(`[Pixel Agents] fs.watchFile failed for agent ${agentId}: ${e}`);
	}

	// Tertiary: manual poll as last resort
	const interval = setInterval(() => {
		if (!agents.has(agentId)) {
			clearInterval(interval);
			try { fs.unwatchFile(filePath); } catch { /* ignore */ }
			return;
		}
		readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
	}, FILE_WATCHER_POLL_INTERVAL_MS);
	pollingTimers.set(agentId, interval);
}

export function readNewLines(
	agentId: number,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;
	try {
		const stat = fs.statSync(agent.jsonlFile);
		if (stat.size <= agent.fileOffset) return;

		const buf = Buffer.alloc(stat.size - agent.fileOffset);
		const fd = fs.openSync(agent.jsonlFile, 'r');
		fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
		fs.closeSync(fd);
		agent.fileOffset = stat.size;

		const text = agent.lineBuffer + buf.toString('utf-8');
		const lines = text.split('\n');
		agent.lineBuffer = lines.pop() || '';

		const hasLines = lines.some(l => l.trim());
		if (hasLines) {
			// New data arriving — cancel timers (data flowing means agent is still active)
			cancelWaitingTimer(agentId, waitingTimers);
			cancelPermissionTimer(agentId, permissionTimers);
			if (agent.permissionSent) {
				agent.permissionSent = false;
				webview?.postMessage({ type: 'agentToolPermissionClear', id: agentId });
			}
		}

		for (const line of lines) {
			if (!line.trim()) continue;
			processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers, webview);
		}
	} catch (e) {
		console.log(`[Pixel Agents] Read error for agent ${agentId}: ${e}`);
	}
}

/** Derive a short project name from a .claude/projects hash dir path.
 *  Mirrors getProjectName() in agentManager.ts (can't import due to circular dep). */
function projectDirToName(projectDir: string): string {
	const hash = path.basename(projectDir);
	const match = hash.match(/-projects-(.+)$/);
	if (match) return match[1];
	const parts = hash.replace(/^-/, '').split('-');
	return parts.length > 2 ? parts.slice(2).join('-') : (parts[parts.length - 1] || hash);
}

/** Returns all .jsonl files under ~/.claude/projects/ across all project subdirs */
function getAllClaudeProjectJsonlFiles(): Array<{ file: string; projectDir: string }> {
	const results: Array<{ file: string; projectDir: string }> = [];
	const base = path.join(os.homedir(), '.claude', 'projects');
	try {
		const dirs = fs.readdirSync(base);
		for (const d of dirs) {
			const pd = path.join(base, d);
			try {
				if (!fs.statSync(pd).isDirectory()) continue;
				const jsonlFiles = fs.readdirSync(pd).filter(f => f.endsWith('.jsonl'));
				for (const f of jsonlFiles) {
					results.push({ file: path.join(pd, f), projectDir: pd });
				}
			} catch { /* ignore */ }
		}
	} catch { /* ignore */ }
	return results;
}

export function ensureProjectScan(
	projectDir: string,
	knownJsonlFiles: Set<string>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	activeAgentIdRef: { current: number | null },
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	if (projectScanTimerRef.current) return;

	const INITIAL_ACTIVE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

	// Seed current-project JSONL files into knownJsonlFiles (for /clear detection)
	// Other-project files are NOT pre-seeded: the periodic scan uses the agents map
	// for dedup, so untracked old sessions can be re-detected when they become active.
	try {
		const files = fs.readdirSync(projectDir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => path.join(projectDir, f));
		for (const f of files) knownJsonlFiles.add(f);
	} catch { /* dir may not exist yet */ }

	// Adopt recently-active sessions from ALL project dirs
	const allFiles = getAllClaudeProjectJsonlFiles();
	console.log(`[Pixel Agents] ensureProjectScan: found ${allFiles.length} total JSONL files, ${agents.size} agents already tracked`);
	for (const { file, projectDir: fileProjDir } of allFiles) {
		// Skip if already tracked by a restored agent
		let tracked = false;
		for (const agent of agents.values()) {
			if (agent.jsonlFile === file) { tracked = true; break; }
		}
		if (tracked) continue;
		try {
			const stat = fs.statSync(file);
			const ageMs = Date.now() - stat.mtimeMs;
			const ageMin = Math.round(ageMs / 60000);
			if (stat.size > 0 && ageMs < INITIAL_ACTIVE_WINDOW_MS) {
				console.log(`[Pixel Agents] Initial scan: adopting ${path.basename(file)} (${path.basename(fileProjDir)}, ${ageMin}min old)`);
				// Start from current file end to avoid replaying old history
				adoptJsonlAsObservedAgent(
					file, fileProjDir, stat.size,
					nextAgentIdRef, agents, activeAgentIdRef,
					fileWatchers, pollingTimers, waitingTimers, permissionTimers,
					webview, persistAgents,
				);
			} else if (stat.size > 0) {
				console.log(`[Pixel Agents] Initial scan: skipping ${path.basename(file)} (${ageMin}min old, too old)`);
			}
		} catch { /* ignore */ }
	}
	console.log(`[Pixel Agents] ensureProjectScan: done, ${agents.size} agents total`);

	projectScanTimerRef.current = setInterval(() => {
		scanForNewJsonlFiles(
			projectDir, knownJsonlFiles, activeAgentIdRef, nextAgentIdRef,
			agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
			webview, persistAgents,
		);
	}, PROJECT_SCAN_INTERVAL_MS);
}

function scanForNewJsonlFiles(
	projectDir: string,
	knownJsonlFiles: Set<string>,
	activeAgentIdRef: { current: number | null },
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	let files: string[];
	try {
		files = fs.readdirSync(projectDir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => path.join(projectDir, f));
	} catch { return; }

	for (const file of files) {
		if (!knownJsonlFiles.has(file)) {
			knownJsonlFiles.add(file);

			// Check if an existing terminal-based agent should be reassigned (/clear)
			if (activeAgentIdRef.current !== null) {
				const activeAgent = agents.get(activeAgentIdRef.current);
				if (activeAgent?.source === 'terminal') {
					console.log(`[Pixel Agents] New JSONL detected: ${path.basename(file)}, reassigning to agent ${activeAgentIdRef.current}`);
					reassignAgentToFile(
						activeAgentIdRef.current, file,
						agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
						webview, persistAgents,
					);
					continue;
				}
			}

			// Try to adopt the focused terminal (existing behavior)
			const activeTerminal = vscode.window.activeTerminal;
			if (activeTerminal) {
				let owned = false;
				for (const agent of agents.values()) {
					if (agent.terminalRef === activeTerminal) {
						owned = true;
						break;
					}
				}
				if (!owned) {
					adoptTerminalForFile(
						activeTerminal, file, projectDir,
						nextAgentIdRef, agents, activeAgentIdRef,
						fileWatchers, pollingTimers, waitingTimers, permissionTimers,
						webview, persistAgents,
					);
					continue;
				}
			}

			// NEW: No terminal owns this file — check if it's an active JSONL (chat mode / external)
			try {
				const stat = fs.statSync(file);
				const ageMs = Date.now() - stat.mtimeMs;
				// Only adopt if the file was modified recently (within 30s)
				if (stat.size > 0 && ageMs < 30_000) {
					console.log(`[Pixel Agents] New active JSONL without terminal: ${path.basename(file)}, creating observed agent`);
					adoptJsonlAsObservedAgent(
						file, projectDir, 0,
						nextAgentIdRef, agents, activeAgentIdRef,
						fileWatchers, pollingTimers, waitingTimers, permissionTimers,
						webview, persistAgents,
					);
				}
			} catch { /* ignore stat errors */ }
		}
	}

	// Also scan all other project dirs for active observed agents (cross-workspace detection).
	// Uses agents map (not knownJsonlFiles) for dedup so re-activated old sessions are detected.
	for (const { file, projectDir: fileProjDir } of getAllClaudeProjectJsonlFiles()) {
		if (fileProjDir === projectDir) continue; // already handled above
		let tracked = false;
		for (const agent of agents.values()) {
			if (agent.jsonlFile === file) { tracked = true; break; }
		}
		if (tracked) continue;
		try {
			const stat = fs.statSync(file);
			const ageMs = Date.now() - stat.mtimeMs;
			if (stat.size > 0 && ageMs < 30_000) {
				console.log(`[Pixel Agents] Active JSONL (${path.basename(fileProjDir)}): ${path.basename(file)}`);
				adoptJsonlAsObservedAgent(
					file, fileProjDir, stat.size,
					nextAgentIdRef, agents, activeAgentIdRef,
					fileWatchers, pollingTimers, waitingTimers, permissionTimers,
					webview, persistAgents,
				);
			}
		} catch { /* ignore */ }
	}

	// Cleanup: remove agents whose JSONL files have been inactive for 2h
	for (const [agentId, agent] of agents) {
		try {
			const stat = fs.statSync(agent.jsonlFile);
			const idleMs = Date.now() - stat.mtimeMs;
			if (idleMs > AGENT_INACTIVE_TIMEOUT_MS) {
				console.log(`[Pixel Agents] Agent ${agentId} (${agent.source}) inactive for ${Math.round(idleMs / 60000)}min, removing`);
				// Stop file watching
				fileWatchers.get(agentId)?.close();
				fileWatchers.delete(agentId);
				const pt = pollingTimers.get(agentId);
				if (pt) { clearInterval(pt); }
				pollingTimers.delete(agentId);
				try { fs.unwatchFile(agent.jsonlFile); } catch { /* ignore */ }
				cancelWaitingTimer(agentId, waitingTimers);
				cancelPermissionTimer(agentId, permissionTimers);
				agents.delete(agentId);
				persistAgents();
				webview?.postMessage({ type: 'agentClosed', id: agentId });
			}
		} catch { /* file may have been deleted */ }
	}
}

function adoptJsonlAsObservedAgent(
	jsonlFile: string,
	projectDir: string,
	initialFileOffset: number,
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	_activeAgentIdRef: { current: number | null },
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	// Don't double-adopt: check if any agent already tracks this file
	for (const agent of agents.values()) {
		if (agent.jsonlFile === jsonlFile) return;
	}

	const id = nextAgentIdRef.current++;
	const folderName = projectDirToName(projectDir);
	const agent: AgentState = {
		id,
		terminalRef: undefined,
		source: 'observed',
		projectDir,
		jsonlFile,
		fileOffset: initialFileOffset,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
		folderName,
	};

	agents.set(id, agent);
	persistAgents();

	console.log(`[Pixel Agents] Agent ${id}: observed (headless) for ${path.basename(jsonlFile)}`);
	webview?.postMessage({ type: 'agentCreated', id, folderName });

	startFileWatching(id, jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
	readNewLines(id, agents, waitingTimers, permissionTimers, webview);
}

function adoptTerminalForFile(
	terminal: vscode.Terminal,
	jsonlFile: string,
	projectDir: string,
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	activeAgentIdRef: { current: number | null },
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	const id = nextAgentIdRef.current++;
	const folderName = projectDirToName(projectDir);
	const agent: AgentState = {
		id,
		terminalRef: terminal,
		source: 'terminal',
		projectDir,
		jsonlFile,
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
		folderName,
	};

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();

	console.log(`[Pixel Agents] Agent ${id}: adopted terminal "${terminal.name}" for ${path.basename(jsonlFile)}`);
	webview?.postMessage({ type: 'agentCreated', id });

	startFileWatching(id, jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
	readNewLines(id, agents, waitingTimers, permissionTimers, webview);
}

export function reassignAgentToFile(
	agentId: number,
	newFilePath: string,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	// Stop old file watching
	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) { clearInterval(pt); }
	pollingTimers.delete(agentId);
	try { fs.unwatchFile(agent.jsonlFile); } catch { /* ignore */ }

	// Clear activity
	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);
	clearAgentActivity(agent, agentId, permissionTimers, webview);

	// Swap to new file
	agent.jsonlFile = newFilePath;
	agent.fileOffset = 0;
	agent.lineBuffer = '';
	persistAgents();

	// Start watching new file
	startFileWatching(agentId, newFilePath, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
	readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
}
