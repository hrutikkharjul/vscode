/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export async function selectCopilotUtilityLanguageModel(): Promise<vscode.LanguageModelChat | undefined> {
	return (await vscode.lm.selectChatModels({ id: 'copilot-utility', vendor: 'copilot' }))[0];
}
