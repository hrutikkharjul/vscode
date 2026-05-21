/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Intrix Solutions. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { loadConfig } from './configLoader';
import { LyzrClient } from './lyzrClient';
import { buildSystemPrompt } from './systemPrompt';
import { parseActions, executeAction, ToolResult } from './tools';

const PARTICIPANT_ID = 'intrix.peri-peri';
const MAX_TOOL_LOOPS = 10;

const COMMAND_PREFIX: Record<string, string> = {
	explain: 'Explain the following code clearly and concisely:',
	fix: 'Find and fix any bugs in the following code:',
	optimize: 'Optimize the following code for performance and readability:',
};

const FOLLOWUPS: vscode.ChatFollowup[] = [
	{ prompt: 'Explain in more detail', label: 'More detail' },
	{ prompt: 'Show me an example', label: 'Show example' },
	{ prompt: 'Fix any issues you see', command: 'fix', label: 'Fix issues' },
	{ prompt: 'How can this be optimized?', command: 'optimize', label: 'Optimize' },
];

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

		// Build initial message
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

		let message = segments.join('\n\n');

		// Tool-use loop
		for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
			if (token.isCancellationRequested) {
				return {};
			}

			stream.progress(loop === 0 ? 'Thinking…' : 'Working…');

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
				return { errorDetails: { message: msg } };
			}

			if (token.isCancellationRequested) {
				return {};
			}

			// Parse actions from response
			const { actions, textWithoutActions } = parseActions(responseText);

			// Output text
			if (textWithoutActions) {
				// Clean up XML noise from the text
				const cleanText = textWithoutActions
					.replace(/<assistant_message>([\s\S]*?)<\/assistant_message>/g, '$1')
					.replace(/<task_plan>[\s\S]*?<\/task_plan>/g, '')
					.trim();
				if (cleanText) {
					stream.markdown(cleanText);
				}
			}

			// No actions = done (or nudge once)
			if (actions.length === 0) {
				if (loop === 0 && textWithoutActions.length > 30) {
					message = 'You described what to do but did not use <actions> blocks. You MUST output <actions> to perform the task. Do it now.';
					continue;
				}
				return { metadata: { agentId, sessionId, presetName: config.presetName } };
			}

			// Execute actions
			const results: ToolResult[] = [];
			for (const action of actions) {
				if (token.isCancellationRequested) {
					return {};
				}
				stream.progress(`${action.type}…`);
				const result = await executeAction(action, stream);
				results.push(result);
			}

			// Send results back for continuation
			const resultBlock = results.map(r =>
				`<tool_result name="${r.tool}" success="${r.success}">\n${r.output.slice(0, 8000)}\n</tool_result>`
			).join('\n');

			message = `${resultBlock}\n\nContinue. If more steps needed, use <actions>. If done, give a brief summary.`;
		}

		stream.markdown('\n\n⚠️ Reached maximum iterations.');
		return { metadata: { agentId, sessionId, presetName: config.presetName } };
	});

	participant.followupProvider = {
		provideFollowups(_result, _context, _token) {
			return FOLLOWUPS;
		},
	};

	context.subscriptions.push(participant);
}

export function deactivate(): void {
	// nothing to clean up
}
