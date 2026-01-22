#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"

type AgentName = "codex" | "claude" | "cursor"
type OutputFormat = "json" | "text"
type InputMode = "auto" | "arg" | "stdin" | "none"

type Options = {
  agent: AgentName | null
  dir: string
  format: OutputFormat
  input: InputMode
  maxBytes: number
  includeContent: boolean
  list: boolean
  modelId?: string
  help?: boolean
}

type AgentConfig = {
  name: AgentName
  cmd: string
  args: string[]
}

type Change = {
  path: string
  status: string
  content?: string
  truncated?: boolean
  binary?: boolean
}

const DEFAULT_FORMAT: OutputFormat = "json"
const DEFAULT_INPUT: InputMode = "auto"
const DEFAULT_MAX_BYTES = 1_000_000

function getEnvValue(name: string): string | undefined {
  return process.env[`AGENT_EXEC_${name}`] ?? process.env[`AGENT_RUN_${name}`]
}

function normalizeMaxBytes(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES
}

function normalizeFormat(value: string | undefined): OutputFormat {
  return value === "json" || value === "text" ? value : DEFAULT_FORMAT
}

function normalizeAgent(value: string | undefined): AgentName | null {
  return value === "codex" || value === "claude" || value === "cursor" ? value : null
}

function normalizeInput(value: string | undefined): InputMode {
  return value === "auto" || value === "arg" || value === "stdin" || value === "none"
    ? value
    : DEFAULT_INPUT
}

function getModelFlag(agent: AgentName): string {
  return (
    getEnvValue(`MODEL_FLAG_${agent.toUpperCase()}`) ||
    getEnvValue("MODEL_FLAG") ||
    "--model"
  )
}

function hasFlag(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000)
  let nonPrintable = 0
  for (const byte of sample) {
    if (byte === 0) return true
    const isPrintable =
      byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)
    if (!isPrintable) nonPrintable += 1
  }
  return sample.length > 0 && nonPrintable / sample.length > 0.3
}

function parseArgs(argv: string[]): { options: Options; prompt: string; passthrough: string[] } {
  const options: Options = {
    agent: normalizeAgent(getEnvValue("AGENT")),
    dir: process.cwd(),
    format: normalizeFormat(getEnvValue("FORMAT")),
    input: normalizeInput(getEnvValue("INPUT")),
    maxBytes: normalizeMaxBytes(getEnvValue("MAX_BYTES")),
    includeContent: getEnvValue("NO_CONTENT") ? false : true,
    list: false,
  }

  const positional: string[] = []
  const passthrough: string[] = []
  let inPassthrough = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (inPassthrough) {
      passthrough.push(arg)
      continue
    }
    if (arg === "--") {
      inPassthrough = true
      continue
    }
    if (arg === "-h" || arg === "--help") {
      options.help = true
      continue
    }
    if (arg === "--list") {
      options.list = true
      continue
    }
    if (arg === "-a" || arg === "--agent") {
      const agent = normalizeAgent(argv[i + 1])
      if (!agent) {
        throw new Error(`Invalid agent: ${argv[i + 1]}. Use codex, claude, or cursor.`)
      }
      options.agent = agent
      i += 1
      continue
    }
    if (arg === "-d" || arg === "--dir") {
      options.dir = argv[i + 1]
      i += 1
      continue
    }
    if (arg === "-m" || arg === "--model" || arg === "--model-id") {
      const value = argv[i + 1]
      if (!value) {
        throw new Error("Missing value for --model.")
      }
      options.modelId = value
      i += 1
      continue
    }
    if (arg === "-f" || arg === "--format") {
      options.format = normalizeFormat(argv[i + 1])
      i += 1
      continue
    }
    if (arg === "--json") {
      options.format = "json"
      continue
    }
    if (arg === "--text") {
      options.format = "text"
      continue
    }
    if (arg === "--input") {
      options.input = normalizeInput(argv[i + 1])
      i += 1
      continue
    }
    if (arg === "--arg") {
      options.input = "arg"
      continue
    }
    if (arg === "--stdin") {
      options.input = "stdin"
      continue
    }
    if (arg === "--no-input") {
      options.input = "none"
      continue
    }
    if (arg === "--max-bytes") {
      options.maxBytes = normalizeMaxBytes(argv[i + 1])
      i += 1
      continue
    }
    if (arg === "--no-content") {
      options.includeContent = false
      continue
    }
    if (arg === "--content") {
      options.includeContent = true
      continue
    }
    positional.push(arg)
  }

  return { options, prompt: positional.join(" ").trim(), passthrough }
}

function getUsage(): string {
  const defaultFormat = normalizeFormat(getEnvValue("FORMAT"))
  const defaultInput = normalizeInput(getEnvValue("INPUT"))
  return `agent-exec <prompt> [options] -- [agent args...]
agent-exec skills <args...>

Options:
  -a, --agent <name>    codex | claude | cursor (required)
  -d, --dir <path>      working directory (default: cwd)
  -m, --model <id>      model ID to pass to the agent CLI
  -f, --format <type>   output format: json or text (default: ${defaultFormat})
  --input <mode>        auto | arg | stdin | none (default: ${defaultInput})
  --max-bytes <n>       max bytes per file in JSON output (default: ${DEFAULT_MAX_BYTES})
  --content             include file contents in JSON (default: true)
  --no-content          omit file contents in JSON
  --list                list detected agents and exit
  -h, --help            show help

Environment:
  AGENT_EXEC_AGENT          agent name (codex | claude | cursor)
  AGENT_EXEC_FORMAT         default output format
  AGENT_EXEC_INPUT          default input mode
  AGENT_EXEC_MAX_BYTES      max bytes per file in JSON output
  AGENT_EXEC_NO_CONTENT     set to disable content in JSON output
  AGENT_EXEC_MODEL_FLAG     model flag to pass to agent CLI (default: --model)
  AGENT_EXEC_MODEL_FLAG_CODEX   override model flag for codex
  AGENT_EXEC_MODEL_FLAG_CLAUDE  override model flag for claude
  AGENT_EXEC_MODEL_FLAG_CURSOR  override model flag for cursor
  AGENT_EXEC_CODEX_CMD      command for codex (default: codex)
  AGENT_EXEC_CLAUDE_CMD     command for claude (default: claude)
  AGENT_EXEC_CURSOR_CMD     command for cursor (default: agent)
  AGENT_EXEC_CODEX_ARGS     default args (supports {prompt})
  AGENT_EXEC_CLAUDE_ARGS    default args (supports {prompt})
  AGENT_EXEC_CURSOR_ARGS    default args (supports {prompt})

Legacy AGENT_RUN_* variables are also supported.
`
}

function splitArgs(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean)
}

function buildAgentConfigs(): AgentConfig[] {
  return [
    {
      name: "codex",
      cmd: getEnvValue("CODEX_CMD") || "codex",
      args: splitArgs(getEnvValue("CODEX_ARGS")),
    },
    {
      name: "claude",
      cmd: getEnvValue("CLAUDE_CMD") || "claude",
      args: splitArgs(getEnvValue("CLAUDE_ARGS")),
    },
    {
      name: "cursor",
      cmd: getEnvValue("CURSOR_CMD") || "agent",
      args: splitArgs(getEnvValue("CURSOR_ARGS")),
    },
  ]
}

function commandExists(cmd: string): boolean {
  const checker = process.platform === "win32" ? "where" : "command"
  const args = process.platform === "win32" ? [cmd] : ["-v", cmd]
  const result = spawnSync(checker, args, {
    shell: process.platform !== "win32",
    stdio: "ignore",
  })
  return result.status === 0
}

function getNpxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx"
}

async function runSkills(args: string[]): Promise<number> {
  if (!commandExists("npx")) {
    console.error("npx is required to run the skills installer. Install Node.js 18+.")
    return 1
  }
  const cmd = getNpxCommand()
  return await new Promise<number>((resolve) => {
    const child = spawn(cmd, ["skills", ...args], { stdio: "inherit" })
    child.on("error", (err) => {
      console.error(err?.message || String(err))
      resolve(1)
    })
    child.on("close", (code) => resolve(code ?? 0))
  })
}

function selectAgent(configs: AgentConfig[], agent: Options["agent"]): AgentConfig | null {
  if (!agent) return null
  return configs.find((config) => config.name === agent) || null
}

function interpolateArgs(args: string[], prompt: string): { args: string[]; usedPrompt: boolean } {
  let used = false
  const out = args.map((arg) => {
    if (arg.includes("{prompt}")) {
      used = true
      return arg.replaceAll("{prompt}", prompt)
    }
    return arg
  })
  return { args: out, usedPrompt: used }
}

async function runAgent({
  config,
  prompt,
  inputMode,
  cwd,
  passthrough,
  format,
  modelId,
}: {
  config: AgentConfig
  prompt: string
  inputMode: InputMode
  cwd: string
  passthrough: string[]
  format: OutputFormat
  modelId?: string
}): Promise<{ exitCode: number; args: string[] }> {
  const interpolated = interpolateArgs(config.args, prompt)
  const modelFlag = getModelFlag(config.name)
  let baseArgs = [...interpolated.args, ...passthrough]
  if (modelId && !hasFlag(baseArgs, modelFlag)) {
    baseArgs = [...baseArgs, modelFlag, modelId]
  }
  let stdinMode: "inherit" | "pipe" = "inherit"
  let finalArgs = baseArgs
  let sendPrompt = false

  if (prompt) {
    if (inputMode === "arg") {
      if (!interpolated.usedPrompt) {
        finalArgs = [...baseArgs, prompt]
      }
    } else if (inputMode === "stdin") {
      stdinMode = "pipe"
      sendPrompt = true
    } else if (inputMode === "auto") {
      if (!interpolated.usedPrompt) {
        finalArgs = [...baseArgs, prompt]
      }
    }
  }

  const usePipes = format === "json" || stdinMode === "pipe"
  const stdio: ("inherit" | "pipe")[] = usePipes
    ? [stdinMode, "pipe", "pipe"]
    : ["inherit", "inherit", "inherit"]

  return await new Promise<{ exitCode: number; args: string[] }>((resolve) => {
    const child = spawn(config.cmd, finalArgs, { cwd, stdio })
    if (usePipes) {
      if (child.stdout) child.stdout.on("data", (chunk) => process.stderr.write(chunk))
      if (child.stderr) child.stderr.on("data", (chunk) => process.stderr.write(chunk))
    }
    if (sendPrompt && child.stdin) {
      child.stdin.write(prompt)
      child.stdin.end()
    }
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 0, args: finalArgs })
    })
  })
}

async function getGitChanges(cwd: string, maxBytes: number, includeContent: boolean): Promise<Change[]> {
  const { stdout, exitCode } = await new Promise<{ stdout: string; exitCode: number }>((resolve) => {
    const child = spawn("git", ["status", "--porcelain=v1"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
    let data = ""
    child.stdout?.on("data", (chunk) => {
      data += chunk.toString("utf-8")
    })
    child.on("close", (code) => resolve({ stdout: data, exitCode: code ?? 1 }))
  })

  if (exitCode !== 0) return []

  const lines = stdout.split(/\r?\n/).filter(Boolean)
  const changes: Change[] = []
  for (const line of lines) {
    const status = line.slice(0, 2).trim()
    let file = line.slice(3).trim()
    if (file.includes(" -> ")) {
      file = file.split(" -> ").pop() || file
    }
    if (!file) continue
    const change: Change = { path: file, status }
    if (includeContent) {
      const absPath = path.resolve(cwd, file)
      try {
      const data = await fs.readFile(absPath)
      if (isProbablyBinary(data)) {
        change.binary = true
      } else if (data.byteLength > maxBytes) {
        change.content = data.subarray(0, maxBytes).toString("utf-8")
        change.truncated = true
      } else {
        change.content = data.toString("utf-8")
      }
      } catch {
        // File may be deleted or unreadable.
      }
    }
    changes.push(change)
  }

  return changes
}

async function listAgents(configs: AgentConfig[]): Promise<void> {
  for (const config of configs) {
    const available = commandExists(config.cmd)
    console.log(`${config.name}\t${available ? "available" : "missing"}\t(${config.cmd})`)
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2)
  if (rawArgs[0] === "skills") {
    const exitCode = await runSkills(rawArgs.slice(1))
    process.exitCode = exitCode
    return
  }

  const { options, prompt, passthrough } = parseArgs(rawArgs)

  if (options.help) {
    console.log(getUsage())
    return
  }

  const configs = buildAgentConfigs()
  if (options.list) {
    await listAgents(configs)
    return
  }

  if (!options.agent) {
    console.error(
      "Missing agent. Pass --agent codex|claude|cursor or set AGENT_EXEC_AGENT (AGENT_RUN_AGENT legacy).",
    )
    console.error(getUsage())
    process.exitCode = 1
    return
  }

  const selected = selectAgent(configs, options.agent)
  if (!selected) {
    console.error("Unknown agent. Use --agent codex|claude|cursor.")
    process.exitCode = 1
    return
  }

  if (!commandExists(selected.cmd)) {
    console.error(
      `Agent CLI not found: ${selected.cmd}. Install it or set AGENT_EXEC_${selected.name.toUpperCase()}_CMD.`,
    )
    process.exitCode = 1
    return
  }

  const cwd = path.resolve(options.dir)
  const runResult = await runAgent({
    config: selected,
    prompt,
    inputMode: options.input,
    cwd,
    passthrough,
    format: options.format,
    modelId: options.modelId,
  })

  if (options.format === "json") {
    const changes = await getGitChanges(cwd, options.maxBytes, options.includeContent)
    const output = {
      ok: runResult.exitCode === 0,
      agent: selected.name,
      model: options.modelId ?? null,
      command: selected.cmd,
      args: runResult.args,
      cwd,
      exitCode: runResult.exitCode,
      changes,
    }
    console.log(JSON.stringify(output, null, 2))
  } else if (runResult.exitCode !== 0) {
    console.error(`agent-exec exited with code ${runResult.exitCode}`)
  }
}

main().catch((err) => {
  console.error(err?.message || String(err))
  process.exitCode = 1
})
