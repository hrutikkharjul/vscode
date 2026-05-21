/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const DEFAULT_BASE_URL = 'https://agent-prod.studio.lyzr.ai';
const DEFAULT_MODEL = 'gpt-5';

const PROFILE_REQUIRED_ANTHROPIC_MODELS = new Set([
	'anthropic.claude-sonnet-4-6',
	'anthropic.claude-haiku-4-5-20251001-v1:0',
	'anthropic.claude-opus-4-7',
	'anthropic.claude-sonnet-4-5-20250929-v1:0',
	'anthropic.claude-opus-4-6-v1',
]);

export interface PeriPeriConfig {
	baseUrl: string;
	apiKey: string;
	userId: string;
	agentId: string;
	sessionId: string;
	presetName: string;
	model: string;
	effectiveModel: string;
	providerId: string;
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

function inferProvider(model: string): string {
	if (/^(bedrock\/|amazon\.|anthropic\.|global\.anthropic\.|us\.anthropic\.|eu\.anthropic\.|au\.anthropic\.|jp\.anthropic\.)/.test(model)) {
		return 'Aws-Bedrock';
	}

	return 'OpenAI';
}

function normalizeModel(providerId: string, inputModel: string): string {
	let rawModel = inputModel.trim();

	if (rawModel.startsWith('bedrock/')) {
		rawModel = rawModel.slice('bedrock/'.length);
	}

	const alreadyScopedAnthropic = /^(global|us|eu|au|jp)\.anthropic\./.test(rawModel);

	if (
		providerId === 'Aws-Bedrock' &&
		rawModel.startsWith('anthropic.claude-') &&
		!alreadyScopedAnthropic &&
		PROFILE_REQUIRED_ANTHROPIC_MODELS.has(rawModel)
	) {
		rawModel = `global.${rawModel}`;
	}

	if (providerId === 'Aws-Bedrock') {
		return `bedrock/${rawModel}`;
	}

	return rawModel;
}

export async function loadConfig(): Promise<PeriPeriConfig> {
	const settings = vscode.workspace.getConfiguration('periPeri');
	const settingsApiKey = settings.get<string>('apiKey', '').trim();
	const settingsUserId = settings.get<string>('userId', '').trim();
	const settingsAgentId = settings.get<string>('agentId', '').trim();
	const settingsSessionId = settings.get<string>('sessionId', '').trim();
	const settingsBaseUrl = settings.get<string>('baseUrl', DEFAULT_BASE_URL).trim();
	const settingsPresetName = settings.get<string>('presetName', '').trim();
	const settingsModel = settings.get<string>('model', DEFAULT_MODEL).trim() || DEFAULT_MODEL;
	const providerId = inferProvider(settingsModel);
	const effectiveModel = normalizeModel(providerId, settingsModel);

	// Explicit VS Code settings take priority
	if (settingsApiKey && settingsUserId) {
		return {
			baseUrl: settingsBaseUrl || DEFAULT_BASE_URL,
			apiKey: settingsApiKey,
			userId: settingsUserId,
			agentId: settingsAgentId,
			sessionId: settingsSessionId,
			presetName: '',
			model: settingsModel,
			effectiveModel,
			providerId,
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
				derivedBase = DEFAULT_BASE_URL;
			}
		}

		return {
			baseUrl: derivedBase || DEFAULT_BASE_URL,
			apiKey: preset.apiKey,
			userId: preset.userId,
			agentId: settingsAgentId || preset.agentId,
			sessionId: settingsSessionId || preset.sessionId,
			presetName: preset.name,
			model: settingsModel,
			effectiveModel,
			providerId,
		};
	}

	// No credentials found
	return {
		baseUrl: settingsBaseUrl || DEFAULT_BASE_URL,
		apiKey: '',
		userId: '',
		agentId: settingsAgentId,
		sessionId: settingsSessionId,
		presetName: '',
		model: settingsModel,
		effectiveModel,
		providerId,
	};
}
