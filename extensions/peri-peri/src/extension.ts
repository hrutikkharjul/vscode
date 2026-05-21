/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Intrix Solutions. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { loadConfig, PeriPeriConfig } from './configLoader';
import { LyzrClient } from './lyzrClient';
import { buildSystemPrompt } from './systemPrompt';
import { parseActions, executeAction, ToolResult } from './tools';

const PARTICIPANT_ID = 'intrix.peri-peri';

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
const MAX_NO_ACTION_NUDGES = 1;
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
}
let pendingTask: PendingTask | undefined;

interface RunResult {
	stoppedReason: 'done' | 'no-actions' | 'repeated-action' | 'checkpoint' | 'cancelled' | 'error';
	stepsSoFar: number;
	totalActionsRun: number;
	errorMessage?: string;
}

function buildHistoryBlock(history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>): string {
	const lines: string[] = [];
	for (const turn of history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			lines.push(`User: ${turn.prompt}`);
		} else if (turn instanceof vscode.ChatResponseTurn) {
			const text = turn.response
				.filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
				.map(p => (typeof p.value === 'string' ? p.value : p.value.value))
				.join('');
			if (text.trim()) {
				lines.push(`Assistant: ${text.trim()}`);
			}
		}
	}
	return lines.join('\n');
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

async function ensureAgentId(client: LyzrClient, agentId: string, cache: vscode.Memento): Promise<string> {
	if (agentId) {
		return agentId;
	}
	const cached = cache.get<string>('periPeri.agentId');
	if (cached) {
		return cached;
	}
	const created = await client.createAgent({
		name: 'peri-peri-vscode',
		providerId: 'Aws-Bedrock',
		model: 'bedrock/global.anthropic.claude-opus-4-7',
		temperature: 0.3,
		topP: 0.9,
	});
	await cache.update('periPeri.agentId', created.agent_id);
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
 * Format tool results into a continuation message, applying both per-tool and
 * overall byte caps so the message we send back to the model stays small.
 * Older results get trimmed first; the most recent result is preserved.
 */
function buildContinuationMessage(results: ReadonlyArray<ToolResult>, stepNumber: number): string {
	const blocks = results.map(r => {
		const body = r.output.length > MAX_RESULT_BYTES_PER_TOOL
			? `${r.output.slice(0, MAX_RESULT_BYTES_PER_TOOL)}\n…[truncated ${r.output.length - MAX_RESULT_BYTES_PER_TOOL} chars]`
			: r.output;
		return `<tool_result name="${r.tool}" success="${r.success}">\n${body}\n</tool_result>`;
	});

	let joined = blocks.join('\n');
	while (joined.length > MAX_CONTINUATION_BYTES && blocks.length > 1) {
		blocks.shift();
		joined = `<tool_result note="older results omitted to fit context" />\n${blocks.join('\n')}`;
	}

	return `${joined}\n\nStep ${stepNumber} complete. The user's original request from <user_request> is NOT yet fulfilled until you emit <done/>. Continue immediately with another <actions> block to make progress on the NEXT concrete step. Do NOT ask the user clarifying questions. Do NOT propose options and wait — pick the most reasonable interpretation and act. The only acceptable terminations are: more <actions>, or <done/> when the request is fully implemented and verified.`;
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
	sessionId: string,
	initialMessage: string,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
	state: {
		stepsSoFar: number;
		totalActionsRun: number;
		actionRepeatCounts: Map<string, number>;
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

		let responseText: string;
		try {
			const response = await client.chat({
				userId: config.userId,
				agentId,
				sessionId,
				message,
			});
			responseText = typeof response.response === 'string'
				? response.response
				: JSON.stringify(response.response ?? response, null, 2);
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

		// Explicit <done/> from the model — stop cleanly even if it also emitted actions.
		if (done && actions.length === 0) {
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
			if (consecutiveNoActions <= MAX_NO_ACTION_NUDGES) {
				message = `You returned no <actions> and no <done/>. The user's request from <user_request> is NOT complete unless you have emitted <done/>. Do NOT ask the user "what next?" — they already told you what to do. Pick the next concrete step and emit it as <actions> RIGHT NOW. If you genuinely believe the original request is fully implemented and verified, emit <done/> instead. No other response is acceptable.`;
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

		// Build the next continuation message *before* deciding to checkpoint —
		// that way the saved snapshot already contains the latest tool results.
		message = buildContinuationMessage(results, state.stepsSoFar);

		// Checkpoint pause — return control to the user every `checkpointInterval`
		// steps within this invocation. The caller saves `pendingTask` and asks
		// the user to resume via /continue.
		if (loop >= checkpointInterval) {
			return { result: { stoppedReason: 'checkpoint', stepsSoFar: state.stepsSoFar, totalActionsRun: state.totalActionsRun }, nextContinuationMessage: message };
		}
	}
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
				`\n\n⏸️ **Paused after ${result.stepsSoFar} steps** (${result.totalActionsRun} actions executed).\n\n` +
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
	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, chatContext, stream, token) => {
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
			agentId = await ensureAgentId(client, config.agentId, context.workspaceState);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			stream.markdown(`**Error creating Lyzr agent**: ${msg}`);
			return { errorDetails: { message: msg } };
		}

		if (token.isCancellationRequested) {
			return {};
		}

		const sessionId = config.sessionId || makeSessionId(agentId);
		const historyBlock = buildHistoryBlock(chatContext.history);
		const fileContext = await resolveFileReferences(request.references);
		const commandPrefix = request.command ? (COMMAND_PREFIX[request.command] ?? '') : '';
		const systemPrompt = buildSystemPrompt();

		const segments: string[] = [systemPrompt];
		if (historyBlock) {
			segments.push(`<conversation_history>\n${historyBlock}\n</conversation_history>`);
		}
		if (fileContext) {
			segments.push(fileContext);
		}
		const userRequest = commandPrefix
			? `${commandPrefix}\n\n${request.prompt.trim()}`
			: request.prompt.trim();
		segments.push(`<user_request>\n${userRequest}\n</user_request>\n\nRespond with <actions> blocks to perform the task. Do NOT just describe — ACT.`);

		const initialMessage = segments.join('\n\n');

		const state = {
			stepsSoFar: 0,
			totalActionsRun: 0,
			actionRepeatCounts: new Map<string, number>(),
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
					{ prompt: 'Continue', label: `▶ Continue another ${interval} step${interval === 1 ? '' : 's'}`, command: 'continue' },
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
