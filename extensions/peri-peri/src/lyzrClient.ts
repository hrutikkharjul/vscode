/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Intrix Solutions. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

export class LyzrClient {
	private readonly baseUrl: string;
	private readonly apiKey: string;

	constructor(config: { baseUrl: string; apiKey: string }) {
		this.baseUrl = config.baseUrl.replace(/\/+$/, '');
		this.apiKey = config.apiKey;
	}

	private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
		if (!this.apiKey) {
			throw new Error('Missing Lyzr API key. Configure periPeri.apiKey in VS Code settings or add a .env file.');
		}

		const response = await fetch(`${this.baseUrl}${path}`, {
			...options,
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': this.apiKey,
				...(options.headers as Record<string, string> ?? {}),
			},
		});

		const text = await response.text();
		let body: any;
		try {
			body = text ? JSON.parse(text) : {};
		} catch {
			body = { raw: text };
		}

		if (!response.ok) {
			throw new Error(body.detail ?? body.raw ?? `HTTP ${response.status}`);
		}

		return body as T;
	}

	async chat(params: { userId: string; agentId: string; sessionId: string; message: string }): Promise<{ response: string }> {
		return this.request('/v3/inference/chat/', {
			method: 'POST',
			body: JSON.stringify({
				user_id: params.userId,
				agent_id: params.agentId,
				session_id: params.sessionId,
				message: params.message,
			}),
		});
	}

	async createAgent(params: { name: string; providerId: string; model: string; temperature?: number; topP?: number }): Promise<{ agent_id: string }> {
		return this.request('/v3/agents/', {
			method: 'POST',
			body: JSON.stringify({
				name: params.name,
				provider_id: params.providerId,
				model: params.model,
				temperature: params.temperature ?? 0.2,
				top_p: params.topP ?? 0.9,
			}),
		});
	}
}
