# agent-exec

`agent-exec` is a thin, agent-friendly wrapper around the Codex, Claude Code, and
Cursor CLIs. It runs the specified agent, forwards the prompt, and emits a JSON
summary of changes (including file contents) for downstream agents.

## Requirements

- Node.js 18+
- One or more agent CLIs installed on your PATH (`codex`, `claude`, `agent`)

## Install / Run

```bash
npx agent-exec "Add a healthcheck endpoint to the API" --agent codex
```

Pass extra args to the underlying CLI, including a model ID:

```bash
npx agent-exec "Refactor the auth flow" --agent claude --model claude-3.5-sonnet -- --max-tokens 2048
```

## Skills

Install skills using the open agent skills ecosystem (via `npx skills add`):

```bash
npx skills add vercel-labs/agent-skills
```

You can also proxy the same command through `agent-exec`:

```bash
npx agent-exec skills add vercel-labs/agent-skills
```

## How it works

- Requires an explicit agent selection (`--agent` or `AGENT_EXEC_AGENT`).
- Runs it in the chosen working directory.
- Emits a JSON summary of `git status` changes, including file contents.

## Options

```bash
agent-exec <prompt> [options] -- [agent args...]
agent-exec skills <args...>

  -a, --agent <name>    codex | claude | cursor (required)
  -d, --dir <path>      working directory (default: cwd)
  -m, --model <id>      model ID to pass to the agent CLI
  -f, --format <type>   output format: json or text (default: json)
  --input <mode>        auto | arg | stdin | none (default: auto)
  --max-bytes <n>       max bytes per file in JSON output (default: 1000000)
  --content             include file contents in JSON (default: true)
  --no-content          omit file contents in JSON
  --list                list detected agents and exit
  -h, --help            show help
```

Flags must come before the prompt. Use `--` to pass flags directly to the agent CLI.

## Output

By default the CLI emits a JSON summary suitable for Codex/Claude/Cursor agents:

```json
{
  "ok": true,
  "agent": "codex",
  "command": "codex",
  "args": [],
  "cwd": "/path/to/repo",
  "exitCode": 0,
  "changes": [
    {
      "path": "src/index.ts",
      "status": "M",
      "content": "..."
    }
  ]
}
```

Use `--format text` for human-friendly output.
Binary files are detected and reported with `"binary": true` without content.

## Configuration

Environment variables for agent overrides:

```bash
AGENT_EXEC_AGENT=claude
AGENT_EXEC_FORMAT=json
AGENT_EXEC_INPUT=auto
AGENT_EXEC_MAX_BYTES=1000000
AGENT_EXEC_NO_CONTENT=1
AGENT_EXEC_MODEL_FLAG=--model
AGENT_EXEC_MODEL_FLAG_CODEX=--model
AGENT_EXEC_MODEL_FLAG_CLAUDE=--model
AGENT_EXEC_MODEL_FLAG_CURSOR=--model
AGENT_EXEC_CODEX_CMD=codex
AGENT_EXEC_CLAUDE_CMD=claude
AGENT_EXEC_CURSOR_CMD=agent
AGENT_EXEC_CODEX_ARGS="--foo {prompt}"
AGENT_EXEC_CLAUDE_ARGS="--bar {prompt}"
AGENT_EXEC_CURSOR_ARGS="--baz {prompt}"
```

Use `{prompt}` in args to substitute the prompt.

Legacy `AGENT_RUN_*` variables are also supported.

Cursor's CLI installs an `agent` binary by default. Set `AGENT_EXEC_CURSOR_CMD=cursor`
if your install uses a different command name.

For non-interactive runs (recommended for automation), configure print mode:

```bash
AGENT_EXEC_CLAUDE_ARGS="-p {prompt}"
AGENT_EXEC_CURSOR_ARGS="-p {prompt}"
```

## Contributing

```bash
npm install
npm run build
npm run lint
```
