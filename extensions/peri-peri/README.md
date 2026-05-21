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

## What It Can Do

| Capability | How |
|-----------|-----|
| ✅ Create/edit files | `write_file`, `replace_in_file` |
| ✅ Read files | `read_file` |
| ✅ Run terminal commands | `run_shell` |
| ✅ Open browser | `open_browser` |
| ✅ Execute VS Code commands | `vscode_command` |
| ✅ List directories | `list_dir` |
| ✅ Multi-step tasks | Loops up to 10 iterations |

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

## Settings Reference

| Setting | Description | Default |
|---------|-------------|---------|
| `periPeri.apiKey` | Lyzr API key | (required) |
| `periPeri.userId` | Lyzr user email | (required) |
| `periPeri.agentId` | Agent ID (leave empty to auto-create) | `""` |
| `periPeri.sessionId` | Session ID (leave empty for fresh each time) | `""` |
| `periPeri.baseUrl` | Lyzr API URL | `https://agent-prod.studio.lyzr.ai` |
| `periPeri.presetName` | Preset from workspace .env | `""` |

## Troubleshooting

**Extension not showing in chat?**  
Make sure you launched VS Code with `--extensionDevelopmentPath` pointing to the full absolute path.

**"Missing Lyzr API credentials"?**  
Add `periPeri.apiKey` and `periPeri.userId` to your VS Code settings JSON.

**Model gives same response every time?**  
Clear `periPeri.agentId` and `periPeri.sessionId` — the extension will create a fresh agent.

**Actions not executing?**  
The model must output `<actions>` XML blocks. If it just describes what to do, the extension nudges it once. If it still doesn't act, the agent's system prompt may be overriding instructions.
