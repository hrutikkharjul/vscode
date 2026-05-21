# Peri Peri — VS Code Chat Extension

AI chat participant for VS Code powered by Lyzr + AWS Bedrock Claude Opus 4.7.  
Supports file editing, terminal commands, browser, and VS Code actions — all from chat.

## Quick Start

```bash
# Clone
git clone https://github.com/hrutikkharjul/vscode.git
cd vscode
git checkout peri-peri

# Install extension dependencies
cd extensions/peri-peri
npm install

# Build
npx tsc
```

## Run

```bash
code --extensionDevelopmentPath="<full-path-to>/vscode/extensions/peri-peri"
```

Example:
```bash
code --extensionDevelopmentPath="C:\Users\hruti\Documents\Intrix\vscode\extensions\peri-peri"
```

## Configure

Once VS Code opens, press `Ctrl+Shift+P` → **"Open User Settings (JSON)"** → add:

```json
{
  "periPeri.apiKey": "sk-default-73Ksx6vvAAgMNgpvumC7SefeqNVyRd87",
  "periPeri.userId": "faultymanoman@gmail.com",
  "periPeri.agentId": "6a0f294aeccd9c1e754cffa1"
}
```

## Use

1. Open Chat panel: `Ctrl+Shift+I`
2. Type `@peri-peri` followed by your request

### Examples

```
@peri-peri create a calculator webpage
@peri-peri open https://google.com in the browser
@peri-peri read package.json and explain what this project does
@peri-peri /fix this code has a bug
@peri-peri run npm install in the terminal
```

### Commands

| Command | Description |
|---------|-------------|
| `@peri-peri /explain` | Explain selected code |
| `@peri-peri /fix` | Find and fix bugs |
| `@peri-peri /optimize` | Optimize for performance |
| `@peri-peri /continue` | Resume the paused multistep task |

## What It Can Do

| Capability | How |
|-----------|-----|
| ✅ Create/edit files | `write_file`, `replace_in_file` |
| ✅ Read files | `read_file` |
| ✅ Run terminal commands | `run_shell` |
| ✅ Open browser | `open_browser` |
| ✅ Execute VS Code commands | `vscode_command` |
| ✅ List directories | `list_dir` |
| ✅ Multi-step tasks | Unbounded tool-use loop with a configurable user check-in checkpoint and an explicit `<done/>` completion signal |

## Architecture

```
VS Code Chat Panel
  → @peri-peri (Chat Participant)
    → Lyzr API (agent-prod.studio.lyzr.ai)
      → AWS Bedrock Claude Opus 4.7
        → Response with <actions> XML blocks
    → Extension parses & executes actions
    → Results sent back for continuation
```

## Multistep task loop

Peri Peri runs an **unbounded** tool-use loop — there is no fixed iteration ceiling.
Tuned for Claude Opus 4.7's long horizon, it keeps calling the model until the task
is finished, the model emits a `<done/>` tag, a safety guard fires, or a checkpoint
is reached.

At each checkpoint the chat turn ends and a **▶ Continue** follow-up button appears.
Click it (or send `@peri-peri /continue`) to resume from the exact point where the
task paused — saved tool results, step counter, and loop-detection state all carry
over. Send any other message to discard the paused task and start fresh.

| Guard | Default | Purpose |
|-------|---------|---------|
| Checkpoint interval | every **25** steps | Pauses the loop and asks the user to confirm before continuing. Configurable via `periPeri.checkpointInterval`. |
| `MAX_REPEATED_ACTION_REPEATS` | 3 | Aborts if the model emits the same action 3× — stops infinite loops. Persists across `/continue`. |
| `MAX_RESULT_BYTES_PER_TOOL` | 4 000 | Per-tool output cap in the continuation message. |
| `MAX_CONTINUATION_BYTES` | 24 000 | Overall cap on the message we send back; older results are dropped first. |
| `<done/>` signal | — | Model emits `<done/>` (optionally with a one-line summary) to finish cleanly. |

Each iteration shows up in the chat panel as `Step N — working…` so you can watch
progress in real time. When the loop ends, the chat result metadata includes
`steps`, `totalActions`, and `stoppedReason`
(`done` / `no-actions` / `repeated-action` / `checkpoint` / `cancelled` / `error`).

## Settings Reference

| Setting | Description | Default |
|---------|-------------|---------|
| `periPeri.apiKey` | Lyzr API key | (required) |
| `periPeri.userId` | Lyzr user email | (required) |
| `periPeri.agentId` | Agent ID (leave empty to auto-create) | `""` |
| `periPeri.sessionId` | Session ID (leave empty for fresh each time) | `""` |
| `periPeri.baseUrl` | Lyzr API URL | `https://agent-prod.studio.lyzr.ai` |
| `periPeri.presetName` | Preset from workspace .env | `""` |
| `periPeri.checkpointInterval` | Steps between user check-ins in the multistep loop | `25` |

## Troubleshooting

**Extension not showing in chat?**  
Make sure you launched VS Code with `--extensionDevelopmentPath` pointing to the full absolute path.

**"Missing Lyzr API credentials"?**  
Add `periPeri.apiKey` and `periPeri.userId` to your VS Code settings JSON.

**Model gives same response every time?**  
Clear `periPeri.agentId` and `periPeri.sessionId` — the extension will create a fresh agent.

**Actions not executing?**  
The model must output `<actions>` XML blocks. If it just describes what to do, the extension nudges it once. If it still doesn't act, the agent's system prompt may be overriding instructions.
