/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Intrix Solutions. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';

export interface ToolResult {
	tool: string;
	success: boolean;
	output: string;
}

/**
 * Tool schema in the XML action format that peri-peri/Lyzr models understand.
 */
export const TOOL_SCHEMAS = `
<toolUseInstructions>
Use the XML action format whenever tools are needed.
No need to ask permission before using a tool.
When multiple independent actions are needed, include them all in a single <actions> block.

Action reference:
- read_file:       <read_file path="file" />
- write_file:      <write_file path="file"><![CDATA[full file contents]]></write_file>
- replace_in_file: <replace_in_file path="file"><search><![CDATA[old text]]></search><replace><![CDATA[new text]]></replace></replace_in_file>
- list_dir:        <list_dir path="." />
- run_shell:       <run_shell><![CDATA[command]]></run_shell>
- vscode_command:  <vscode_command name="command.id" />
- open_browser:    <open_browser url="https://example.com" />

Example:
<actions>
  <write_file path="index.html"><![CDATA[
<!DOCTYPE html>
<html><body><h1>Hello</h1></body></html>
  ]]></write_file>
  <open_browser url="index.html" />
</actions>

IMPORTANT: Always wrap your tool uses in <actions>...</actions> tags.
Do NOT just describe what you will do. Actually DO IT by outputting <actions> blocks.
</toolUseInstructions>
`;

/**
 * Parse XML-style action blocks from model response.
 */
export function parseActions(text: string): { actions: ParsedAction[]; textWithoutActions: string } {
	const actions: ParsedAction[] = [];
	const actionsPattern = /<actions>([\s\S]*?)<\/actions>/g;
	let match;

	while ((match = actionsPattern.exec(text)) !== null) {
		const block = match[1];
		// Parse individual actions within the block
		parseReadFile(block, actions);
		parseWriteFile(block, actions);
		parseReplaceInFile(block, actions);
		parseListDir(block, actions);
		parseRunShell(block, actions);
		parseVscodeCommand(block, actions);
		parseOpenBrowser(block, actions);
	}

	const textWithoutActions = text.replace(actionsPattern, '').trim();
	return { actions, textWithoutActions };
}

interface ParsedAction {
	type: string;
	args: Record<string, any>;
}

function parseReadFile(block: string, actions: ParsedAction[]): void {
	const pattern = /<read_file\s+path="([^"]+)"\s*\/>/g;
	let m;
	while ((m = pattern.exec(block)) !== null) {
		actions.push({ type: 'read_file', args: { path: m[1] } });
	}
}

function parseWriteFile(block: string, actions: ParsedAction[]): void {
	const pattern = /<write_file\s+path="([^"]+)">\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/write_file>/g;
	let m;
	while ((m = pattern.exec(block)) !== null) {
		actions.push({ type: 'write_file', args: { path: m[1], content: m[2].trim() } });
	}
	// Also handle without CDATA
	const pattern2 = /<write_file\s+path="([^"]+)">([\s\S]*?)<\/write_file>/g;
	while ((m = pattern2.exec(block)) !== null) {
		if (!m[2].includes('CDATA')) {
			actions.push({ type: 'write_file', args: { path: m[1], content: m[2].trim() } });
		}
	}
}

function parseReplaceInFile(block: string, actions: ParsedAction[]): void {
	const pattern = /<replace_in_file\s+path="([^"]+)">\s*<search>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/search>\s*<replace>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/replace>\s*<\/replace_in_file>/g;
	let m;
	while ((m = pattern.exec(block)) !== null) {
		actions.push({ type: 'replace_in_file', args: { path: m[1], oldStr: m[2], newStr: m[3] } });
	}
}

function parseListDir(block: string, actions: ParsedAction[]): void {
	const pattern = /<list_dir\s+path="([^"]+)"\s*\/>/g;
	let m;
	while ((m = pattern.exec(block)) !== null) {
		actions.push({ type: 'list_dir', args: { path: m[1] } });
	}
}

function parseRunShell(block: string, actions: ParsedAction[]): void {
	const pattern = /<run_shell>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/run_shell>/g;
	let m;
	while ((m = pattern.exec(block)) !== null) {
		actions.push({ type: 'run_shell', args: { command: m[1].trim() } });
	}
	// Without CDATA
	const pattern2 = /<run_shell>([\s\S]*?)<\/run_shell>/g;
	while ((m = pattern2.exec(block)) !== null) {
		if (!m[1].includes('CDATA')) {
			actions.push({ type: 'run_shell', args: { command: m[1].trim() } });
		}
	}
}

function parseVscodeCommand(block: string, actions: ParsedAction[]): void {
	const pattern = /<vscode_command\s+name="([^"]+)"\s*\/>/g;
	let m;
	while ((m = pattern.exec(block)) !== null) {
		actions.push({ type: 'vscode_command', args: { command: m[1] } });
	}
}

function parseOpenBrowser(block: string, actions: ParsedAction[]): void {
	const pattern = /<open_browser\s+url="([^"]+)"\s*\/>/g;
	let m;
	while ((m = pattern.exec(block)) !== null) {
		actions.push({ type: 'open_browser', args: { url: m[1] } });
	}
}

/**
 * Execute a parsed action.
 */
export async function executeAction(action: ParsedAction, stream: vscode.ChatResponseStream): Promise<ToolResult> {
	try {
		switch (action.type) {
			case 'read_file':
				return await execReadFile(action.args);
			case 'write_file':
				return await execWriteFile(action.args, stream);
			case 'replace_in_file':
				return await execReplaceInFile(action.args, stream);
			case 'list_dir':
				return await execListDir(action.args);
			case 'run_shell':
				return await execRunShell(action.args, stream);
			case 'vscode_command':
				return await execVscodeCommand(action.args, stream);
			case 'open_browser':
				return await execOpenBrowser(action.args, stream);
			default:
				return { tool: action.type, success: false, output: `Unknown action: ${action.type}` };
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { tool: action.type, success: false, output: `Error: ${msg}` };
	}
}

// --- Implementations ---

function resolvePath(p: string): string {
	if (path.isAbsolute(p)) {
		return p;
	}
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
	return path.join(root, p);
}

async function execReadFile(args: Record<string, any>): Promise<ToolResult> {
	const filePath = resolvePath(args.path);
	const uri = vscode.Uri.file(filePath);
	const bytes = await vscode.workspace.fs.readFile(uri);
	return { tool: 'read_file', success: true, output: new TextDecoder().decode(bytes) };
}

async function execWriteFile(args: Record<string, any>, stream: vscode.ChatResponseStream): Promise<ToolResult> {
	const filePath = resolvePath(args.path);
	const uri = vscode.Uri.file(filePath);
	// Ensure parent directory exists
	const dir = path.dirname(filePath);
	try {
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
	} catch { /* already exists */ }
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(args.content));
	stream.markdown(`\n📝 Created: \`${args.path}\`\n`);
	return { tool: 'write_file', success: true, output: `Written: ${filePath}` };
}

async function execReplaceInFile(args: Record<string, any>, stream: vscode.ChatResponseStream): Promise<ToolResult> {
	const filePath = resolvePath(args.path);
	const uri = vscode.Uri.file(filePath);
	const bytes = await vscode.workspace.fs.readFile(uri);
	const original = new TextDecoder().decode(bytes);
	if (!original.includes(args.oldStr)) {
		return { tool: 'replace_in_file', success: false, output: 'Search string not found' };
	}
	const updated = original.replace(args.oldStr, args.newStr);
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(updated));
	stream.markdown(`\n✏️ Edited: \`${args.path}\`\n`);
	return { tool: 'replace_in_file', success: true, output: `Replaced in ${filePath}` };
}

async function execListDir(args: Record<string, any>): Promise<ToolResult> {
	const dirPath = resolvePath(args.path);
	const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
	const lines = entries.map(([name, type]) =>
		`${type === vscode.FileType.Directory ? '📁' : '📄'} ${name}`
	);
	return { tool: 'list_dir', success: true, output: lines.join('\n') };
}

async function execRunShell(args: Record<string, any>, stream: vscode.ChatResponseStream): Promise<ToolResult> {
	const cmd = args.command;
	stream.markdown(`\n⚡ Running: \`${cmd}\`\n`);
	const terminal = vscode.window.createTerminal({
		name: 'Peri Peri',
		cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
	});
	terminal.show();
	terminal.sendText(cmd);
	return { tool: 'run_shell', success: true, output: `Sent to terminal: ${cmd}` };
}

async function execVscodeCommand(args: Record<string, any>, stream: vscode.ChatResponseStream): Promise<ToolResult> {
	const cmd = args.command;
	stream.markdown(`\n🔧 VS Code: \`${cmd}\`\n`);
	await vscode.commands.executeCommand(cmd);
	return { tool: 'vscode_command', success: true, output: `Executed: ${cmd}` };
}

async function execOpenBrowser(args: Record<string, any>, stream: vscode.ChatResponseStream): Promise<ToolResult> {
	const url = args.url;
	stream.markdown(`\n🌐 Opening: [${url}](${url})\n`);
	try {
		await vscode.commands.executeCommand('simpleBrowser.api.open', url, { viewColumn: vscode.ViewColumn.Beside });
	} catch {
		try {
			await vscode.commands.executeCommand('simpleBrowser.show', url);
		} catch {
			await vscode.env.openExternal(vscode.Uri.parse(url));
		}
	}
	return { tool: 'open_browser', success: true, output: `Opened: ${url}` };
}
