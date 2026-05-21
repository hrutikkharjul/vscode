/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as childProcess from 'child_process';

export interface ToolResult {
	tool: string;
	success: boolean;
	output: string;
}

// run_shell tuning. The shell tool captures stdout+stderr from the spawned
// process so the model can see what actually happened. To keep the chat and the
// continuation message bounded:
//   - RUN_SHELL_TIMEOUT_MS:        kill long-running commands (dev servers etc.).
//   - RUN_SHELL_MAX_DISPLAY_BYTES: cap on what we print into the chat panel.
//   - RUN_SHELL_MAX_OUTPUT_BYTES:  cap on what we hand back to the model.
const RUN_SHELL_TIMEOUT_MS = 60_000;
const RUN_SHELL_MAX_DISPLAY_BYTES = 4000;
const RUN_SHELL_MAX_OUTPUT_BYTES = 8000;

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
- replace_in_file: <replace_in_file path="file">
                     <search><![CDATA[exact text from the file, including indentation]]></search>
                     <replace><![CDATA[new text]]></replace>
                   </replace_in_file>
- list_dir:        <list_dir path="." />
- run_shell:       <run_shell><![CDATA[command]]></run_shell>
                   Runs in the OS default shell (cmd.exe on Windows, /bin/sh on
                   POSIX) with stdout+stderr captured and returned to you, plus
                   the exit code — so iterate based on the actual output. 60s
                   timeout. For long-running processes (dev servers, watchers)
                   that should keep running, background them: "start /B ..." on
                   Windows, "... &" on POSIX.
- vscode_command:  <vscode_command name="command.id" />
- open_browser:    <open_browser url="https://example.com" />

Notes on replace_in_file:
- The <search> block must match a UNIQUE region of the file. Only the first
  occurrence is replaced.
- Whitespace and indentation must match the file exactly (read_file first if
  unsure). The runtime auto-normalises CRLF vs LF, so don't worry about that.
- For brand-new files, use write_file. For broad rewrites of an existing file,
  prefer write_file with the full new contents over many replace_in_file calls.

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
 *
 * Returns:
 *  - actions:            list of tool invocations to execute, in document order.
 *  - textWithoutActions: the model's prose with <actions> blocks (and <done/> markers) stripped.
 *  - done:               true if the model emitted a <done/> tag, signalling task completion.
 */
export function parseActions(text: string): {
	actions: ParsedAction[];
	textWithoutActions: string;
	done: boolean;
} {
	const actions: ParsedAction[] = [];

	// Strip markdown code fences that some models wrap around XML output
	const cleaned = text.replace(/```(?:xml)?\s*\n?([\s\S]*?)\n?```/g, '$1');

	// Try parsing from <actions>...</actions> blocks first
	const actionsPattern = /<actions>([\s\S]*?)<\/actions>/g;
	let match;
	while ((match = actionsPattern.exec(cleaned)) !== null) {
		const block = match[1];
		parseReadFile(block, actions);
		parseWriteFile(block, actions);
		parseReplaceInFile(block, actions);
		parseListDir(block, actions);
		parseRunShell(block, actions);
		parseVscodeCommand(block, actions);
		parseOpenBrowser(block, actions);
	}

	// If no <actions> wrapper found, try parsing bare tool calls from the full text.
	// GPT-4o sometimes outputs tool XML directly without the wrapper.
	if (actions.length === 0) {
		parseReadFile(cleaned, actions);
		parseWriteFile(cleaned, actions);
		parseReplaceInFile(cleaned, actions);
		parseListDir(cleaned, actions);
		parseRunShell(cleaned, actions);
		parseVscodeCommand(cleaned, actions);
		parseOpenBrowser(cleaned, actions);
	}

	// Detect explicit completion signal
	const donePattern = /<done\s*\/>|<done>\s*<\/done>/i;
	const done = donePattern.test(cleaned);

	// Strip parsed content from text output
	let textWithoutActions = cleaned
		.replace(actionsPattern, '')
		.replace(/<done\s*\/>/gi, '')
		.replace(/<done>\s*<\/done>/gi, '');

	// If we parsed bare tool calls, strip them too
	if (actions.length > 0) {
		textWithoutActions = textWithoutActions
			.replace(/<write_file[\s\S]*?<\/write_file>/g, '')
			.replace(/<read_file\s+path="[^"]+"\s*\/>/g, '')
			.replace(/<list_dir\s+path="[^"]+"\s*\/>/g, '')
			.replace(/<run_shell>[\s\S]*?<\/run_shell>/g, '')
			.replace(/<replace_in_file[\s\S]*?<\/replace_in_file>/g, '')
			.replace(/<vscode_command\s+name="[^"]+"\s*\/>/g, '')
			.replace(/<open_browser\s+url="[^"]+"\s*\/>/g, '');
	}

	return { actions, textWithoutActions: textWithoutActions.trim(), done };
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

/**
 * Extract the inner text of a tag from a block. Supports both the CDATA-wrapped
 * form `<tag><![CDATA[...]]></tag>` and the bare form `<tag>...</tag>`.
 *
 * For CDATA blocks, a single leading newline immediately after `[CDATA[` and a
 * single trailing newline immediately before `]]>` are stripped — they're
 * formatting artifacts of multi-line XML, not part of the intended content.
 * Without this, search strings produced by the model don't match the file
 * because of spurious wrapping whitespace.
 */
function extractTaggedContent(source: string, tag: string): string | null {
	const cdataRe = new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`);
	const cdataMatch = cdataRe.exec(source);
	if (cdataMatch) {
		return stripWrapperNewlines(cdataMatch[1]);
	}
	const plainRe = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
	const plainMatch = plainRe.exec(source);
	if (plainMatch) {
		return stripWrapperNewlines(plainMatch[1]);
	}
	return null;
}

function stripWrapperNewlines(s: string): string {
	let r = s;
	if (r.startsWith('\r\n')) {
		r = r.slice(2);
	} else if (r.startsWith('\n')) {
		r = r.slice(1);
	}
	if (r.endsWith('\r\n')) {
		r = r.slice(0, -2);
	} else if (r.endsWith('\n')) {
		r = r.slice(0, -1);
	}
	return r;
}

function truncateForLog(s: string, max: number): string {
	if (s.length <= max) {
		return s;
	}
	return `${s.slice(0, max)}…[+${s.length - max} chars]`;
}

function parseWriteFile(block: string, actions: ParsedAction[]): void {
	// Single pattern for both CDATA and bare forms — the CDATA wrapper is
	// stripped in extractTaggedContent. Only a single leading/trailing newline
	// (the formatting artifact) is removed, so trailing newlines that are part
	// of the file content are preserved.
	const pattern = /<write_file\s+path="([^"]+)">([\s\S]*?)<\/write_file>/g;
	let m;
	while ((m = pattern.exec(block)) !== null) {
		const filePath = m[1];
		const inner = m[2];
		const cdataMatch = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
		const content = cdataMatch
			? stripWrapperNewlines(cdataMatch[1])
			: stripWrapperNewlines(inner);
		actions.push({ type: 'write_file', args: { path: filePath, content } });
	}
}

function parseReplaceInFile(block: string, actions: ParsedAction[]): void {
	const wrapper = /<replace_in_file\s+path="([^"]+)">([\s\S]*?)<\/replace_in_file>/g;
	let m;
	while ((m = wrapper.exec(block)) !== null) {
		const filePath = m[1];
		const inner = m[2];
		const oldStr = extractTaggedContent(inner, 'search');
		const newStr = extractTaggedContent(inner, 'replace');
		if (oldStr !== null && newStr !== null) {
			actions.push({ type: 'replace_in_file', args: { path: filePath, oldStr, newStr } });
		}
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
	const pattern = /<run_shell>([\s\S]*?)<\/run_shell>/g;
	let m;
	while ((m = pattern.exec(block)) !== null) {
		const inner = m[1];
		const cdataMatch = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
		const command = cdataMatch
			? stripWrapperNewlines(cdataMatch[1]).trim()
			: stripWrapperNewlines(inner).trim();
		if (command) {
			actions.push({ type: 'run_shell', args: { command } });
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
export async function executeAction(
	action: ParsedAction,
	stream: vscode.ChatResponseStream,
	token?: vscode.CancellationToken,
): Promise<ToolResult> {
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
				return await execRunShell(action.args, stream, token);
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
	// Sanitize: model sometimes outputs \n or \r in paths (e.g. \notes-app becomes newline+otes-app)
	const sanitized = p.replace(/[\r\n]+/g, '').trim();
	if (path.isAbsolute(sanitized)) {
		return sanitized;
	}
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
	return path.join(root, sanitized);
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

	// Track whether the file already existed so we can report Created vs Updated
	// — both for the user's chat output and for the model's tool_result.
	let existed = false;
	try {
		await vscode.workspace.fs.stat(uri);
		existed = true;
	} catch {
		// did not exist
	}

	// Ensure parent directory exists
	const dir = path.dirname(filePath);
	try {
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
	} catch { /* already exists */ }

	const content: string = typeof args.content === 'string' ? args.content : String(args.content ?? '');
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));

	const verb = existed ? 'Updated' : 'Created';
	const icon = existed ? '✏️' : '📝';
	stream.markdown(`\n${icon} ${verb}: \`${args.path}\`\n`);
	return { tool: 'write_file', success: true, output: `${verb}: ${filePath} (${content.length} chars)` };
}

async function execReplaceInFile(args: Record<string, any>, stream: vscode.ChatResponseStream): Promise<ToolResult> {
	const filePath = resolvePath(args.path);
	const uri = vscode.Uri.file(filePath);

	let original: string;
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		original = new TextDecoder().decode(bytes);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			tool: 'replace_in_file',
			success: false,
			output: `Could not read ${filePath}: ${msg}. The file may not exist — use list_dir to verify the path or write_file to create it.`,
		};
	}

	const oldStr: string = typeof args.oldStr === 'string' ? args.oldStr : '';
	const newStr: string = typeof args.newStr === 'string' ? args.newStr : '';

	if (!oldStr) {
		return {
			tool: 'replace_in_file',
			success: false,
			output: 'Empty <search> block. Provide the exact text to replace.',
		};
	}

	// Detect the file's predominant line ending so we can preserve it on write.
	const fileEol: '\r\n' | '\n' = original.includes('\r\n') ? '\r\n' : '\n';

	let updated: string | null = null;
	let matchStrategy = 'exact';

	// Strategy 1: exact byte match.
	if (original.includes(oldStr)) {
		updated = original.replace(oldStr, newStr);
	}

	// Strategy 2: normalize line endings on both sides and retry. This handles
	// the common case where the file is CRLF on Windows but the model emitted
	// LF-only search/replace strings (or vice versa).
	if (updated === null) {
		const norm = (s: string) => s.replace(/\r\n/g, '\n');
		const origN = norm(original);
		const oldN = norm(oldStr);
		if (origN.includes(oldN)) {
			const newN = norm(newStr);
			const updatedN = origN.replace(oldN, newN);
			updated = fileEol === '\r\n' ? updatedN.replace(/\n/g, '\r\n') : updatedN;
			matchStrategy = 'eol-normalized';
		}
	}

	if (updated === null) {
		// Helpful diagnostic so the model can self-correct on the next turn.
		const lines = [
			`Search string not found in ${filePath}.`,
			``,
			`Looked for (${oldStr.length} chars):`,
			truncateForLog(oldStr, 600),
			``,
			`File content (${original.length} chars):`,
			truncateForLog(original, 1200),
			``,
			`Tip: read_file the file again and copy the EXACT text — including indentation, blank lines, and line endings. The runtime already retries with CRLF/LF normalised, so a remaining mismatch is in the actual characters.`,
		];
		return { tool: 'replace_in_file', success: false, output: lines.join('\n') };
	}

	if (updated === original) {
		return {
			tool: 'replace_in_file',
			success: true,
			output: `No change needed in ${filePath} — the replacement is identical to the existing text.`,
		};
	}

	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(updated));
	stream.markdown(`\n✏️ Edited: \`${args.path}\`\n`);
	const note = matchStrategy === 'eol-normalized' ? ' (matched after EOL normalisation)' : '';
	return { tool: 'replace_in_file', success: true, output: `Replaced in ${filePath}${note}` };
}

async function execListDir(args: Record<string, any>): Promise<ToolResult> {
	const dirPath = resolvePath(args.path);
	const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
	const lines = entries.map(([name, type]) =>
		`${type === vscode.FileType.Directory ? '📁' : '📄'} ${name}`
	);
	return { tool: 'list_dir', success: true, output: lines.join('\n') };
}

async function execRunShell(
	args: Record<string, any>,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken | undefined,
): Promise<ToolResult> {
	let cmd: string = typeof args.command === 'string' ? args.command : '';
	// Fix path corruption: backslash + 'n'/'t'/'r' in paths gets parsed as escape sequences.
	// Replace literal newlines/tabs that break commands (e.g. "cd peri-peri\notes-app" → newline)
	cmd = cmd.replace(/\r?\n/g, ' && ').trim();
	if (!cmd) {
		return { tool: 'run_shell', success: false, output: 'Empty command.' };
	}

	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	stream.markdown(`\n⚡ Running: \`${cmd}\`\n`);

	return await new Promise<ToolResult>((resolve) => {
		// shell:true uses the OS default shell — cmd.exe on Windows (process.env.ComSpec),
		// /bin/sh on POSIX. windowsHide:true keeps a console window from flashing on Win.
		const child = childProcess.spawn(cmd, [], {
			cwd,
			shell: true,
			windowsHide: true,
		});

		// On Windows, child.kill() only signals the shell wrapper — to actually
		// stop the spawned tree we need taskkill /T /F. On POSIX SIGKILL on the
		// shell child propagates to the group via shell:true semantics.
		const killTree = () => {
			if (!child.pid) {
				return;
			}
			if (process.platform === 'win32') {
				try {
					childProcess.execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true });
				} catch { /* already exited */ }
			} else {
				try { child.kill('SIGKILL'); } catch { /* already exited */ }
			}
		};

		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let cancelled = false;

		const timer = setTimeout(() => {
			timedOut = true;
			killTree();
		}, RUN_SHELL_TIMEOUT_MS);

		const cancelDisposable = token?.onCancellationRequested(() => {
			cancelled = true;
			killTree();
		});

		child.stdout?.on('data', (d) => { stdout += d.toString(); });
		child.stderr?.on('data', (d) => { stderr += d.toString(); });

		child.on('error', (err) => {
			clearTimeout(timer);
			cancelDisposable?.dispose();
			const msg = `Failed to start: ${err.message}`;
			stream.markdown(`\n❌ ${msg}\n`);
			resolve({ tool: 'run_shell', success: false, output: msg });
		});

		child.on('close', (code, signal) => {
			clearTimeout(timer);
			cancelDisposable?.dispose();

			const combinedRaw = stderr
				? `${stdout}${stdout && !stdout.endsWith('\n') ? '\n' : ''}[stderr]\n${stderr}`
				: stdout;
			const combined = combinedRaw.replace(/\r\n/g, '\n').replace(/\u001b\[[0-9;]*m/g, '').trimEnd();

			const display = combined.length > RUN_SHELL_MAX_DISPLAY_BYTES
				? `${combined.slice(0, RUN_SHELL_MAX_DISPLAY_BYTES)}\n…[truncated ${combined.length - RUN_SHELL_MAX_DISPLAY_BYTES} chars]`
				: combined;
			if (display) {
				stream.markdown(`\n\`\`\`\n${display}\n\`\`\`\n`);
			}

			let status: string;
			let success = false;
			if (cancelled) {
				status = '⏹️ Cancelled';
			} else if (timedOut) {
				status = `⏱️ Timed out after ${RUN_SHELL_TIMEOUT_MS / 1000}s`;
			} else if (code === 0) {
				status = '✅ Exit 0';
				success = true;
			} else if (code !== null) {
				status = `❌ Exit ${code}`;
			} else if (signal) {
				status = `❌ Signal ${signal}`;
			} else {
				status = '❌ Unknown exit';
			}
			stream.markdown(`\n${status}\n`);

			const modelOutput = combined.length > RUN_SHELL_MAX_OUTPUT_BYTES
				? `${combined.slice(0, RUN_SHELL_MAX_OUTPUT_BYTES)}\n…[truncated ${combined.length - RUN_SHELL_MAX_OUTPUT_BYTES} chars]`
				: combined;

			resolve({
				tool: 'run_shell',
				success,
				output: modelOutput ? `${status}\n${modelOutput}` : status,
			});
		});
	});
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
