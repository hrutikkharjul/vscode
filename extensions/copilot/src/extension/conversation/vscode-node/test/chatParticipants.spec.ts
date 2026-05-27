/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectChatModels } = vi.hoisted(() => ({
	selectChatModels: vi.fn(),
}));

vi.mock('vscode', () => ({
	lm: {
		selectChatModels,
	},
}));

import { selectCopilotUtilityLanguageModel } from '../languageModelSelectors';

describe('Chat participants', () => {
	beforeEach(() => {
		selectChatModels.mockReset();
	});

	it('switchToBaseModel selects the copilot utility alias', async () => {
		const selectedModel = { vendor: 'copilot', id: 'copilot-utility', family: 'copilot-utility', name: 'Base Model' };
		selectChatModels.mockResolvedValue([selectedModel]);

		const result = await selectCopilotUtilityLanguageModel();

		expect(selectChatModels).toHaveBeenCalledWith({ id: 'copilot-utility', vendor: 'copilot' });
		assert.strictEqual(result?.id, 'copilot-utility');
	});
});
