/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Intrix Solutions. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface PeriPeriConfig {
	baseUrl: string;
	apiKey: string;
	userId: string;
	agentId: string;
	sessionId: string;
	presetName: string;
}

interface EnvEndpoint {
	name: string;
	url: string;
	apiKey: string;
	userId: string;
	agentId: string;
	sessionId: string;
}

/**
 * Parses the legacy .env file format used by peri-peri CLI.
 * The file contains a TypeScript-like object literal with agent endpoint definitions.
 */
function parseLegacyEnvEndpoints(source: string): EnvEndpoint[] {
	const objectStart = source.indexOf('= {');
	if (objectStart === -1) {
		return [];
	}

	const endpoints: EnvEndpoint[] = [];
	const entryPattern = /'([^']+)':\s*\{([\s\S]*?)\n\s*\}/g;

	for (const match of source.slice(objectStart).matchAll(entryPattern)) {
		const [, name, body] = match;
		const fields: Record<string, string> = {};

		for (const fieldMatch of body.matchAll(/(url|apiKey|user_id|agent_id|session_id):\s*'([^']*)'/g)) {
			fields[fieldMatch[1]] = fieldMatch[2];
		}

		if (fields['url'] && fields['apiKey'] && fields['user_id']) {
			endpoints.push({
				name,
				url: fields['url'],
				apiKey: fields['apiKey'],
				userId: fields['user_id'],
				agentId: fields['agent_id'] ?? '',
				sessionId: fields['session_id'] ?? '',
			});
		}
	}

	return endpoints;
}

async function readWorkspaceEnv(): Promise<EnvEndpoint[]> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return [];
	}

	const envUri = vscode.Uri.joinPath(folder.uri, '.env');
	try {
		const bytes = await vscode.workspace.fs.readFile(envUri);
		const source = new TextDecoder().decode(bytes);
		return parseLegacyEnvEndpoints(source);
	} catch {
		return [];
	}
}

export async function loadConfig(): Promise<PeriPeriConfig> {
	const settings = vscode.workspace.getConfiguration('periPeri');
	const settingsApiKey = settings.get<string>('apiKey', '').trim();
	const settingsUserId = settings.get<string>('userId', '').trim();
	const settingsAgentId = settings.get<string>('agentId', '').trim();
	const settingsSessionId = settings.get<string>('sessionId', '').trim();
	const settingsBaseUrl = settings.get<string>('baseUrl', 'https://agent-prod.studio.lyzr.ai').trim();
	const settingsPresetName = settings.get<string>('presetName', '').trim();

	// Explicit VS Code settings take priority
	if (settingsApiKey && settingsUserId) {
		return {
			baseUrl: settingsBaseUrl || 'https://agent-prod.studio.lyzr.ai',
			apiKey: settingsApiKey,
			userId: settingsUserId,
			agentId: settingsAgentId,
			sessionId: settingsSessionId,
			presetName: '',
		};
	}

	// Fall back to the workspace .env file (peri-peri legacy format)
	const presets = await readWorkspaceEnv();
	if (presets.length > 0) {
		const preset = settingsPresetName
			? (presets.find(p => p.name === settingsPresetName) ?? presets[0])
			: presets[0];

		let derivedBase = settingsBaseUrl;
		if (!derivedBase && preset.url) {
			try {
				derivedBase = new URL(preset.url).origin;
			} catch {
				derivedBase = 'https://agent-prod.studio.lyzr.ai';
			}
		}

		return {
			baseUrl: derivedBase || 'https://agent-prod.studio.lyzr.ai',
			apiKey: preset.apiKey,
			userId: preset.userId,
			agentId: settingsAgentId || preset.agentId,
			sessionId: settingsSessionId || preset.sessionId,
			presetName: preset.name,
		};
	}

	// No credentials found
	return {
		baseUrl: settingsBaseUrl || 'https://agent-prod.studio.lyzr.ai',
		apiKey: '',
		userId: '',
		agentId: settingsAgentId,
		sessionId: settingsSessionId,
		presetName: '',
	};
}
