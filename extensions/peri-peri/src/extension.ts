/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { loadConfig, PeriPeriConfig } from './configLoader';
import { LyzrClient } from './lyzrClient';
import { parseActions, executeAction, ToolResult } from './tools';

const PARTICIPANT_ID = 'intrix.peri-peri';

// Debug output channel — visible via "Output" panel → "Peri Peri" in the dev host.
let outputChannel: vscode.OutputChannel;
const AGENT_CACHE_KEY = 'periPeri.agentCache.v2';

// Multistep task loop tuning.
//
// The loop is UNBOUNDED — there is no hard ceiling on iterations. Tuned for
// Claude Opus 4.7's long horizon, the runtime instead checks in with the user
// every `checkpointInterval` steps (configurable via periPeri.checkpointInterval,
// default 25) and asks them to confirm before continuing. Per-turn safety is
// still enforced by:
//   1. MAX_REPEATED_ACTION_REPEATS    — break out if the model emits the exact
//                                       same action this many times (likely stuck).
//   2. MAX_NO_ACTION_NUDGES            — break out if the model keeps responding
//                                       with prose only and never emits <done/>.
//   3. MAX_RESULT_BYTES_PER_TOOL     — per-tool output cap to keep messages small.
//   4. MAX_CONTINUATION_BYTES         — overall cap on the continuation message
//                                       sent back to the model after each step.
//   5. An explicit <done/> tag the model can emit to finish cleanly.
//   6. The chat-turn cancellation token (Esc / cancel button).
const DEFAULT_CHECKPOINT_INTERVAL = 25;
const MAX_REPEATED_ACTION_REPEATS = 3;
const MAX_NO_ACTION_NUDGES = 2;
const MAX_RESULT_BYTES_PER_TOOL = 4000;
const MAX_CONTINUATION_BYTES = 24_000;

const COMMAND_PREFIX: Record<string, string> = {
	explain: 'Explain the following code clearly and concisely:',
	fix: 'Find and fix any bugs in the following code:',
	optimize: 'Optimize the following code for performance and readability:',
};

const DEFAULT_FOLLOWUPS: vscode.ChatFollowup[] = [
	{ prompt: 'Explain in more detail', label: 'More detail' },
	{ prompt: 'Show me an example', label: 'Show example' },
	{ prompt: 'Fix any issues you see', command: 'fix', label: 'Fix issues' },
	{ prompt: 'How can this be optimized?', command: 'optimize', label: 'Optimize' },
];

/**
 * Snapshot of an in-progress multistep task that has been paused at a checkpoint.
 * Stored in a module-level slot — the assumption is that the user has at most one
 * paused peri-peri task per VS Code window at a time. A new request that is not
 * `/continue` discards any pending snapshot.
 */
interface PendingTask {
	continuationMessage: string;                  // next message to send the model
	actionRepeatEntries: Array<[string, number]>; // serialised loop-detection counts
	totalActionsRun: number;
	stepsSoFar: number;                            // total steps already completed
	agentId: string;
	sessionId: string;
	presetName: string;
	savedAt: number;
	originalTask: string;
	allPriorResults: string[];
}
let pendingTask: PendingTask | undefined;

interface RunResult {
	stoppedReason: 'done' | 'no-actions' | 'repeated-action' | 'checkpoint' | 'cancelled' | 'error';
	stepsSoFar: number;
	totalActionsRun: number;
	errorMessage?: string;
}

async function resolveFileReferences(references: readonly vscode.ChatPromptReference[]): Promise<string> {
	const parts: string[] = [];
	for (const ref of references) {
		if (typeof ref.value === 'string' && ref.value.trim()) {
			parts.push(`<attached_content id="${ref.id}">\n${ref.value}\n</attached_content>`);
		} else if (ref.value instanceof vscode.Uri) {
			try {
				const bytes = await vscode.workspace.fs.readFile(ref.value);
				const text = new TextDecoder().decode(bytes);
				parts.push(`<attached_file path="${ref.value.fsPath}">\n${text}\n</attached_file>`);
			} catch {
				// skip unreadable files
			}
		}
	}
	return parts.join('\n\n');
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
}

function agentCacheEntryKey(config: Pick<PeriPeriConfig, 'providerId' | 'effectiveModel'>): string {
	return `${config.providerId}::${config.effectiveModel}`;
}

async function ensureAgentId(client: LyzrClient, configuredAgentId: string, cache: vscode.Memento, config: Pick<PeriPeriConfig, 'providerId' | 'model' | 'effectiveModel'>): Promise<string> {
	if (configuredAgentId) {
		outputChannel.appendLine(`Using configured agent: ${configuredAgentId}`);
		return configuredAgentId;
	}

	const cacheKey = agentCacheEntryKey(config);
	const cachedAgents = cache.get<Record<string, string>>(AGENT_CACHE_KEY, {});
	const cached = cachedAgents[cacheKey];
	if (cached) {
		outputChannel.appendLine(`Reusing cached agent for ${cacheKey}: ${cached}`);
		return cached;
	}

	outputChannel.appendLine(`Creating new Lyzr agent for ${config.providerId}/${config.effectiveModel} (input model: ${config.model})...`);
	const created = await client.createAgent({
		name: `peri-peri-${slugify(config.effectiveModel)}`,
		systemPrompt: `You are Peri Peri, an expert coding agent that completes tasks autonomously using XML tool calls.

CORE BEHAVIOR:
- You ALWAYS output <actions> blocks with tool calls to make progress
- You use RELATIVE paths (e.g. "notes-app/src/App.js"), never absolute paths
- You use forward slashes in paths, never backslashes
- When a task is COMPLETE, output <done/> with no actions block
- After open_browser succeeds, output <done/> immediately

DEBUGGING:
- If a command fails, READ the error message carefully
- Try a DIFFERENT approach — do not repeat the same failing command
- If a file is not found, use list_dir to find the correct path
- If npm install fails, check if package.json exists first
- If a path doesn't work, use list_dir to verify the directory structure

ENVIRONMENT:
- Windows OS, use cmd.exe commands (dir, mkdir, del, type)
- For dev servers (npm start), use: start /B cmd /c "cd folder && npm start"
- Working directory is the VS Code workspace root`,
		providerId: config.providerId,
		model: config.effectiveModel,
		temperature: 0.2,
		topP: 0.9,
	});
	outputChannel.appendLine(`Agent created: ${created.agent_id}`);
	await cache.update(AGENT_CACHE_KEY, {
		...cachedAgents,
		[cacheKey]: created.agent_id,
	});
	return created.agent_id;
}

function makeSessionId(agentId: string): string {
	const suffix = crypto.randomBytes(6).toString('hex');
	const safe = agentId.replace(/[^a-z0-9]/gi, '').slice(0, 24);
	return `${safe}-${suffix}`;
}

/**
 * Build a stable signature for a parsed action so we can detect when the model
 * keeps emitting the same step. Args that contain large blobs (file contents,
 * shell scripts) are folded down to a short normalised+truncated form, which
 * keeps the signature compact while still catching repeats.
 */
function signatureFor(action: { type: string; args: Record<string, any> }): string {
	const args = action.args ?? {};
	const parts: string[] = [];
	for (const key of Object.keys(args).sort()) {
		const raw = args[key];
		const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
		parts.push(`${key}=${truncate(str.replace(/\s+/g, ' ').trim(), 200)}`);
	}
	return `${action.type}(${parts.join('|')})`;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) {
		return s;
	}
	return `${s.slice(0, max)}…[+${s.length - max} chars]`;
}

/**
 * The tool schema block included in every message to the model.
 * Must be concise — verbose instructions trigger Claude's injection detection.
 */
const INLINE_TOOL_SCHEMA = `You have these tools. Output ALL tool calls needed inside a single <actions> block:

<write_file path="file"><![CDATA[content]]></write_file>
<read_file path="file" />
<list_dir path="." />
<run_shell><![CDATA[command]]></run_shell>
<replace_in_file path="file"><search><![CDATA[old]]></search><replace><![CDATA[new]]></replace></replace_in_file>
<open_browser url="https://..." />
<vscode_command name="command.id" />

Rules:
- Wrap ALL tool calls in a single <actions>...</actions> block
- Include ALL files needed for the task in ONE response — do NOT stop after one file
- Use Windows cmd.exe commands (dir, type, mkdir, del) not Unix
- Use RELATIVE paths (e.g. "notes-app/src/App.js") not absolute paths
- NEVER put backslash-n in paths. Use forward slashes: notes-app/src/App.js
- If a tool call FAILS, read the error, diagnose the problem, and try a DIFFERENT approach. Do NOT retry the same command more than once.
- For long-running commands (npm start, dev servers), background them: "start /B cmd" on Windows
- You MUST output an <actions> block. Do NOT just describe what you will do. ACT.`;

/**
 * Format tool results into a continuation message. Each call is stateless
 * (fresh session) so we include the tool schema, previous results as context,
 * and the remaining task framing.
 */
function buildContinuationMessage(
	results: ReadonlyArray<ToolResult>,
	stepNumber: number,
	originalTask: string,
	allPriorResults: string[],
): string {
	// Format latest results — include full output so the model can see file
	// contents from read_file and full error messages from failures.
	const latestResults = results.map(r => {
		const body = r.output.length > MAX_RESULT_BYTES_PER_TOOL
			? `${r.output.slice(0, MAX_RESULT_BYTES_PER_TOOL)}\n…[truncated]`
			: r.output;
		return `<tool_result name="${r.tool}" success="${r.success}">\n${body}\n</tool_result>`;
	});

	// Build accumulated history of completed steps (capped)
	const newEntries = latestResults;
	allPriorResults.push(...newEntries);
	let stepsBlock = allPriorResults.join('\n');
	if (stepsBlock.length > MAX_CONTINUATION_BYTES) {
		stepsBlock = `…[earlier steps omitted]\n${allPriorResults.slice(-5).join('\n')}`;
	}

	return `${INLINE_TOOL_SCHEMA}

Original task: ${originalTask}

Results from step ${stepNumber}:
${stepsBlock}

If the task is fully complete, output <done/> with no actions block.
Otherwise, continue working — output your next <actions> block:

<actions>`;
}

function getCheckpointInterval(): number {
	const raw = vscode.workspace.getConfiguration('periPeri').get<number>('checkpointInterval', DEFAULT_CHECKPOINT_INTERVAL);
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) {
		return DEFAULT_CHECKPOINT_INTERVAL;
	}
	return Math.floor(raw);
}

/**
 * Run the unbounded tool-use loop. Returns when the model finishes (<done/>
 * or no actions), the loop detector trips, the user cancels, or a checkpoint
 * is reached. On checkpoint, the caller is responsible for saving `pendingTask`
 * and asking the user to resume via /continue.
 */
async function runMultistepLoop(
	client: LyzrClient,
	config: PeriPeriConfig,
	agentId: string,
	_sessionId: string,
	initialMessage: string,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
	state: {
		stepsSoFar: number;
		totalActionsRun: number;
		actionRepeatCounts: Map<string, number>;
		originalTask: string;
		allPriorResults: string[];
	},
): Promise<{ result: RunResult; nextContinuationMessage: string }> {
	const checkpointInterval = getCheckpointInterval();
	const stepsAtStart = state.stepsSoFar;

	let message = initialMessage;
	let loop = 0; // iterations completed *in this invocation*
	let consecutiveNoActions = 0; // counts how many times in a row the model sent prose without <actions>/<done/>

	while (true) {
		if (token.isCancellationRequested) {
			return { result: { stoppedReason: 'cancelled', stepsSoFar: state.stepsSoFar, totalActionsRun: state.totalActionsRun }, nextContinuationMessage: message };
		}

		const stepDisplay = state.stepsSoFar + 1;
		stream.progress(loop === 0 && stepsAtStart === 0 ? 'Thinking…' : `Step ${stepDisplay} — working…`);

		// Use a FRESH session ID for each API call. Claude rejects tool_results
		// in the same session as "fabricated". Stateless calls work reliably.
		const callSessionId = `${agentId.slice(0, 12)}-${Date.now().toString(36)}`;

		let responseText: string;
		try {
			outputChannel.appendLine(`\n--- SENDING (step ${state.stepsSoFar + 1}, session=${callSessionId}) ---`);
			outputChannel.appendLine(message.length > 2000 ? `${message.slice(0, 2000)}\n…[${message.length} chars total]` : message);
			const response = await client.chat({
				userId: config.userId,
				agentId,
				sessionId: callSessionId,
				message,
			});
			responseText = typeof response.response === 'string'
				? response.response
				: JSON.stringify(response.response ?? response, null, 2);
			outputChannel.appendLine(`\n--- RECEIVED (step ${state.stepsSoFar + 1}, ${responseText.length} chars) ---`);
			outputChannel.appendLine(responseText.length > 2000 ? `${responseText.slice(0, 2000)}\n…[${responseText.length} chars total]` : responseText);

			// Raw log to file for debugging
			const logUri = vscode.Uri.joinPath(
				vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd()),
				'.peri-peri-log.txt'
			);
			const logEntry = `\n${'='.repeat(60)}\n[${new Date().toISOString()}] Step ${state.stepsSoFar + 1}\nSENT (${message.length} chars): ${message.slice(0, 500)}...\nRECEIVED (${responseText.length} chars):\n${responseText}\n`;
			try {
				let existing = '';
				try { existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(logUri)); } catch { /* new file */ }
				await vscode.workspace.fs.writeFile(logUri, new TextEncoder().encode(existing + logEntry));
			} catch { /* ignore log failures */ }
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			stream.markdown(`**Peri Peri error**: ${msg}`);
			return { result: { stoppedReason: 'error', stepsSoFar: state.stepsSoFar, totalActionsRun: state.totalActionsRun, errorMessage: msg }, nextContinuationMessage: message };
		}

		if (token.isCancellationRequested) {
			return { result: { stoppedReason: 'cancelled', stepsSoFar: state.stepsSoFar, totalActionsRun: state.totalActionsRun }, nextContinuationMessage: message };
		}

		const { actions, textWithoutActions, done } = parseActions(responseText);

		if (textWithoutActions) {
			const cleanText = textWithoutActions
				.replace(/<assistant_message>([\s\S]*?)<\/assistant_message>/g, '$1')
				.replace(/<task_plan>[\s\S]*?<\/task_plan>/g, '')
				.trim();
			if (cleanText) {
				stream.markdown(cleanText);
			}
		}

		// Explicit <done/> from the model — stop cleanly, UNLESS it's the very
		// first iteration and no actions have been executed (model just greeted).
		if (done && actions.length === 0) {
			if (state.stepsSoFar === 0 && state.totalActionsRun === 0) {
				// Model tried to bail without doing anything — nudge it
				message = `You output <done/> without performing any actions. The task is NOT complete. You MUST use your tools to complete the task. Output an <actions> block now:\n\n<actions>`;
				continue;
			}
			return { result: { stoppedReason: 'done', stepsSoFar: state.stepsSoFar, totalActionsRun: state.totalActionsRun }, nextContinuationMessage: message };
		}

		// No actions and no <done/>: the model is idling on prose. Nudge once to
		// force it to either keep working or explicitly finish, then bail. This
		// catches the failure mode where the model runs read_file / list_dir and
		// then writes "let me know what you'd like next" — instead of stopping
		// silently we tell it to keep going. The check fires on every iteration
		// (not just iteration 0) because the failure can happen mid-task too.
		if (actions.length === 0) {
			consecutiveNoActions++;
			outputChannel.appendLine(`\n--- NO ACTIONS (nudge ${consecutiveNoActions}/${MAX_NO_ACTION_NUDGES}, done=${done}) ---`);
			if (consecutiveNoActions <= MAX_NO_ACTION_NUDGES) {
				if (consecutiveNoActions === 1) {
					message = `You did not output any <actions> block. Please use your tools to make progress on the task. For example:\n<actions>\n  <list_dir path="." />\n</actions>`;
				} else {
					message = `Please output an <actions> block now, or <done/> if the task is complete.`;
				}
				continue;
			}
			return { result: { stoppedReason: 'no-actions', stepsSoFar: state.stepsSoFar, totalActionsRun: state.totalActionsRun }, nextContinuationMessage: message };
		}
		consecutiveNoActions = 0;

		// Loop detection across the whole task (survives resume).
		let repeatedAction: string | undefined;
		for (const action of actions) {
			const sig = signatureFor(action);
			const next = (state.actionRepeatCounts.get(sig) ?? 0) + 1;
			state.actionRepeatCounts.set(sig, next);
			if (next >= MAX_REPEATED_ACTION_REPEATS) {
				repeatedAction = sig;
				break;
			}
		}
		if (repeatedAction) {
			stream.markdown(`\n\n⚠️ Same action repeated ${MAX_REPEATED_ACTION_REPEATS}× (\`${truncate(repeatedAction, 120)}\`). Stopping to avoid a loop.`);
			return { result: { stoppedReason: 'repeated-action', stepsSoFar: state.stepsSoFar, totalActionsRun: state.totalActionsRun }, nextContinuationMessage: message };
		}

		// Execute actions
		const results: ToolResult[] = [];
		for (const action of actions) {
			if (token.isCancellationRequested) {
				return { result: { stoppedReason: 'cancelled', stepsSoFar: state.stepsSoFar, totalActionsRun: state.totalActionsRun }, nextContinuationMessage: message };
			}
			stream.progress(`Step ${stepDisplay} — ${action.type}…`);
			let result: ToolResult;
			try {
				result = await executeAction(action, stream, token);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				result = { tool: action.type, success: false, output: `Unhandled error: ${msg}` };
			}
			results.push(result);
			state.totalActionsRun++;
		}

		state.stepsSoFar++;
		loop++;

		// If the model emitted <done/> alongside actions, execute the actions
		// (already done above) then stop — the task is complete.
		if (done) {
			return { result: { stoppedReason: 'done', stepsSoFar: state.stepsSoFar, totalActionsRun: state.totalActionsRun }, nextContinuationMessage: message };
		}

		// Auto-done: if the only actions in this step were open_browser (all succeeded),
		// the task is complete — don't loop back asking for more.
		const allBrowser = actions.length > 0 && actions.every(a => a.type === 'open_browser');
		const allSucceeded = results.every(r => r.success);
		if (allBrowser && allSucceeded) {
			return { result: { stoppedReason: 'done', stepsSoFar: state.stepsSoFar, totalActionsRun: state.totalActionsRun }, nextContinuationMessage: message };
		}

		// Build the next continuation message *before* deciding to checkpoint —
		// that way the saved snapshot already contains the latest tool results.
		message = buildContinuationMessage(results, state.stepsSoFar, state.originalTask, state.allPriorResults);

		// Checkpoint pause — return control to the user every `checkpointInterval`
		// steps within this invocation. The caller saves `pendingTask` and asks
		// the user to resume via /continue.
		if (loop >= checkpointInterval) {
			return { result: { stoppedReason: 'checkpoint', stepsSoFar: state.stepsSoFar, totalActionsRun: state.totalActionsRun }, nextContinuationMessage: message };
		}
	}
}

/**
 * Extract recent chat history from VS Code's ChatContext for conversational continuity.
 * Keeps the last N turns to avoid blowing up the context window.
 */
function buildChatHistory(chatContext: vscode.ChatContext, maxTurns = 10): string {
	const history = chatContext.history;
	if (!history || history.length === 0) {
		return '';
	}

	const recent = history.slice(-maxTurns);
	const lines: string[] = [];

	for (const turn of recent) {
		if (turn instanceof vscode.ChatRequestTurn) {
			lines.push(`User: ${turn.prompt}`);
		} else if (turn instanceof vscode.ChatResponseTurn) {
			// Extract text parts from the response
			const parts: string[] = [];
			for (const part of turn.response) {
				if (part instanceof vscode.ChatResponseMarkdownPart) {
					parts.push(part.value.value);
				}
			}
			if (parts.length > 0) {
				const text = parts.join('').slice(0, 2000);
				lines.push(`Assistant: ${text}`);
			}
		}
	}

	if (lines.length === 0) {
		return '';
	}

	return `<conversation_history>\n${lines.join('\n')}\n</conversation_history>`;
}

/**
 * Get active editor context: current file path, language, and selection/visible code.
 */
function getEditorContext(): string {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return '';
	}

	const doc = editor.document;
	const filePath = vscode.workspace.asRelativePath(doc.uri);
	const lang = doc.languageId;

	let codeSnippet = '';
	const selection = editor.selection;
	if (!selection.isEmpty) {
		codeSnippet = doc.getText(selection).slice(0, 3000);
	} else {
		// Use visible range as context
		const visibleRange = editor.visibleRanges[0];
		if (visibleRange) {
			codeSnippet = doc.getText(visibleRange).slice(0, 3000);
		}
	}

	const parts = [`<active_editor path="${filePath}" language="${lang}">`];
	if (codeSnippet) {
		parts.push(codeSnippet);
	}
	parts.push('</active_editor>');

	return parts.join('\n');
}

/**
 * Render the appropriate end-of-turn markdown for a stop reason and return the
 * ChatResult metadata.
 */
function finaliseResult(
	stream: vscode.ChatResponseStream,
	result: RunResult,
	context: { agentId: string; sessionId: string; presetName: string },
): vscode.ChatResult {
	switch (result.stoppedReason) {
		case 'checkpoint': {
			const interval = getCheckpointInterval();
			stream.markdown(
				`\n\n**Paused after ${result.stepsSoFar} steps** (${result.totalActionsRun} actions executed).\n\n` +
				`Send \`@peri-peri /continue\` (or click **Continue** below) to keep going for another ${interval} step${interval === 1 ? '' : 's'}. ` +
				`Send any other message to start a new task — the paused one will be discarded.`
			);
			break;
		}
		case 'no-actions':
		case 'done':
			// Model finished cleanly; nothing extra to render — its own summary
			// (or a short <done/> message) was already streamed above.
			break;
		case 'repeated-action':
			// The warning was already streamed inside the loop.
			break;
		case 'cancelled':
			// VS Code already shows a cancellation indicator.
			break;
		case 'error':
			// Error was already streamed.
			break;
	}

	const errorDetails = result.stoppedReason === 'error' && result.errorMessage
		? { errorDetails: { message: result.errorMessage } }
		: {};

	return {
		...errorDetails,
		metadata: {
			agentId: context.agentId,
			sessionId: context.sessionId,
			presetName: context.presetName,
			steps: result.stepsSoFar,
			totalActions: result.totalActionsRun,
			stoppedReason: result.stoppedReason,
		},
	};
}

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel('Peri Peri');
	context.subscriptions.push(outputChannel);

	// Command to reset the agent — forces creation of a new one with our system prompt.
	const resetCmd = vscode.commands.registerCommand('periPeri.resetAgent', async () => {
		await context.workspaceState.update(AGENT_CACHE_KEY, undefined);
		await context.workspaceState.update('periPeri.agentId', undefined);
		await context.workspaceState.update('periPeri.agentId.v2', undefined);
		await context.workspaceState.update('periPeri.agentId.v3', undefined);
		await context.workspaceState.update('periPeri.agentId.v4', undefined);
		await context.workspaceState.update('periPeri.agentId.v5', undefined);
		vscode.window.showInformationMessage('Peri Peri: Agent reset. A new agent will be created on next chat message.');
	});
	context.subscriptions.push(resetCmd);

	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, chatContext, stream, token) => {
		// Lyzr API (only backend)
		const config = await loadConfig();

		if (!config.apiKey || !config.userId) {
			stream.markdown(
				'**Peri Peri** — no credentials found.\n\n' +
				'Configure `periPeri.apiKey` and `periPeri.userId` in VS Code settings.'
			);
			return { errorDetails: { message: 'Missing Lyzr API credentials' } };
		}

		const client = new LyzrClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });

		// ---- Resume path: /continue ----
		if (request.command === 'continue') {
			if (!pendingTask) {
				stream.markdown('**No paused task to resume.** Send a new request to start one.');
				return { metadata: { stoppedReason: 'no-actions', steps: 0, totalActions: 0 } };
			}
			const saved = pendingTask;
			pendingTask = undefined; // claim it; will be re-saved if we hit another checkpoint

			stream.progress(`Resuming from step ${saved.stepsSoFar}…`);

			const state = {
				stepsSoFar: saved.stepsSoFar,
				totalActionsRun: saved.totalActionsRun,
				actionRepeatCounts: new Map(saved.actionRepeatEntries),
				originalTask: saved.originalTask ?? '',
				allPriorResults: saved.allPriorResults ?? [],
			};

			const { result, nextContinuationMessage } = await runMultistepLoop(
				client,
				config,
				saved.agentId,
				saved.sessionId,
				saved.continuationMessage,
				stream,
				token,
				state,
			);

			if (result.stoppedReason === 'checkpoint') {
				pendingTask = {
					continuationMessage: nextContinuationMessage,
					actionRepeatEntries: Array.from(state.actionRepeatCounts.entries()),
					totalActionsRun: state.totalActionsRun,
					stepsSoFar: state.stepsSoFar,
					agentId: saved.agentId,
					sessionId: saved.sessionId,
					presetName: saved.presetName,
					savedAt: Date.now(),
					originalTask: state.originalTask,
					allPriorResults: state.allPriorResults,
				};
			}

			return finaliseResult(stream, result, {
				agentId: saved.agentId,
				sessionId: saved.sessionId,
				presetName: saved.presetName,
			});
		}

		// Any other request implicitly cancels a paused task.
		if (pendingTask) {
			pendingTask = undefined;
		}

		// ---- New task path ----
		stream.progress('Connecting to Peri Peri…');

		let agentId: string;
		try {
			agentId = await ensureAgentId(client, config.agentId, context.workspaceState, config);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			stream.markdown(`**Error creating Lyzr agent**: ${msg}`);
			return { errorDetails: { message: msg } };
		}

		if (token.isCancellationRequested) {
			return {};
		}

		const sessionId = config.sessionId || makeSessionId(agentId);
		outputChannel.appendLine(`\n${'='.repeat(40)}\nAgent: ${agentId}\nUser: ${config.userId}\nBase URL: ${config.baseUrl}\nProvider: ${config.providerId}\nInput Model: ${config.model}\nEffective Model: ${config.effectiveModel}\n${'='.repeat(40)}`);
		const fileContext = await resolveFileReferences(request.references);
		const commandPrefix = request.command ? (COMMAND_PREFIX[request.command] ?? '') : '';

		const userRequest = commandPrefix
			? `${commandPrefix}\n\n${request.prompt.trim()}`
			: request.prompt.trim();

		// Gather contextual information
		const historyBlock = buildChatHistory(chatContext);
		const editorBlock = getEditorContext();

		// Build initial message with inline tool schema (proven to work via API testing).
		// Each API call uses a FRESH session ID because Claude rejects tool_results
		// in the same session as "fabricated". Stateless approach works reliably.
		const initialMessage = `${INLINE_TOOL_SCHEMA}
${historyBlock ? '\n' + historyBlock + '\n' : ''}${editorBlock ? '\n' + editorBlock + '\n' : ''}${fileContext ? '\n' + fileContext + '\n' : ''}
Task: ${userRequest}

IMPORTANT: Do NOT greet the user. Do NOT ask questions. Do NOT output <done/>. Start working IMMEDIATELY by outputting an <actions> block. Write files directly — do not use scaffolding tools.

<actions>`;

		const state = {
			stepsSoFar: 0,
			totalActionsRun: 0,
			actionRepeatCounts: new Map<string, number>(),
			originalTask: userRequest,
			allPriorResults: [] as string[],
		};

		const { result, nextContinuationMessage } = await runMultistepLoop(
			client,
			config,
			agentId,
			sessionId,
			initialMessage,
			stream,
			token,
			state,
		);

		if (result.stoppedReason === 'checkpoint') {
			pendingTask = {
				continuationMessage: nextContinuationMessage,
				actionRepeatEntries: Array.from(state.actionRepeatCounts.entries()),
				totalActionsRun: state.totalActionsRun,
				stepsSoFar: state.stepsSoFar,
				agentId,
				sessionId,
				presetName: config.presetName,
				savedAt: Date.now(),
				originalTask: state.originalTask,
				allPriorResults: state.allPriorResults,
			};
		}

		return finaliseResult(stream, result, { agentId, sessionId, presetName: config.presetName });
	});

	participant.followupProvider = {
		provideFollowups(result, _context, _token) {
			const meta = (result as vscode.ChatResult).metadata as { stoppedReason?: string } | undefined;
			if (meta?.stoppedReason === 'checkpoint') {
				const interval = getCheckpointInterval();
				return [
					{ prompt: 'Continue', label: `Continue another ${interval} step${interval === 1 ? '' : 's'}`, command: 'continue' },
					{ prompt: 'Stop here', label: 'Stop here' },
				];
			}
			return DEFAULT_FOLLOWUPS;
		},
	};

	context.subscriptions.push(participant);
}

export function deactivate(): void {
	pendingTask = undefined;
}
