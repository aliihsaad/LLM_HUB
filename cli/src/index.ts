#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const packagePath = path.join(rootDir, 'cli', 'package.json');
const rootPackagePath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(fs.existsSync(packagePath) ? packagePath : rootPackagePath, 'utf-8'));
const builtServerEntry = path.join(rootDir, 'server', 'dist', 'index.js');
const builtClientEntry = path.join(rootDir, 'client', 'dist', 'index.html');

const DEFAULT_SERVER_URL = 'http://localhost:3001';

interface CliOptions {
  server?: string;
}

type ChatRole = 'system' | 'user' | 'assistant';

interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface ChatRequestOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

type AgentToolName =
  | 'list_files'
  | 'read_file'
  | 'search'
  | 'replace_in_file'
  | 'write_file'
  | 'run_command'
  | 'finish';

interface AgentToolCall {
  tool: AgentToolName;
  reason?: string;
  args?: Record<string, unknown>;
}

interface AgentOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  cwd: string;
  yes?: boolean;
  maxSteps: number;
  stream?: boolean;
}

function serverUrl(options?: CliOptions): string {
  return (options?.server ?? process.env.LLMHUB_SERVER_URL ?? DEFAULT_SERVER_URL).replace(/\/$/, '');
}

async function apiRequest<T>(pathname: string, options: CliOptions & RequestInit = {}): Promise<T> {
  const { server, ...init } = options;
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(`${serverUrl({ server })}${pathname}`, { ...init, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const message = data?.error?.message ?? data?.message ?? `HTTP ${res.status}`;
    throw new Error(message);
  }

  return data as T;
}

function bool(value: unknown): string {
  return value ? 'yes' : 'no';
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function printRows(rows: Record<string, unknown>[], json?: boolean) {
  if (json) {
    printJson(rows);
    return;
  }
  console.table(rows);
}

function cleanModel(model?: string): string | undefined {
  if (!model || model === 'auto') return undefined;
  return model;
}

function compactText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function postChatCompletion(
  messages: ChatMessage[],
  requestOptions: ChatRequestOptions,
  cliOptions: CliOptions,
): Promise<string> {
  const body: Record<string, unknown> = {
    messages,
    temperature: requestOptions.temperature,
    max_tokens: requestOptions.maxTokens,
    stream: requestOptions.stream ?? true,
  };
  const model = cleanModel(requestOptions.model);
  if (model) body.model = model;

  const res = await fetch(`${serverUrl(cliOptions)}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message ?? parsed?.message ?? text;
    } catch {}
    throw new Error(message || `HTTP ${res.status}`);
  }

  if (!requestOptions.stream) {
    const payload = await res.json() as any;
    return compactText(payload?.choices?.[0]?.message?.content);
  }

  if (!res.body) throw new Error('No response body from server.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;

    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const delta = compactText(parsed?.choices?.[0]?.delta?.content);
        const message = compactText(parsed?.choices?.[0]?.message?.content);
        const text = delta || message;
        if (text) {
          fullText += text;
          process.stdout.write(text);
        }
      } catch {
        // Ignore malformed provider frames; the proxy may still continue.
      }
    }
  }

  process.stdout.write('\n');
  return fullText;
}

function joinPrompt(parts?: string[]): string {
  return (parts ?? []).join(' ').trim();
}

function resolveCliPath(value: string, cwd: string): string {
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

function shouldSkipPath(filePath: string): boolean {
  const parts = filePath.split(/[\\/]/);
  return parts.some(part => ['.git', 'node_modules', 'dist', 'data', '.next', 'coverage'].includes(part));
}

function collectContextFiles(inputPath: string): string[] {
  if (!fs.existsSync(inputPath) || shouldSkipPath(inputPath)) return [];
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) return [inputPath];
  if (!stat.isDirectory()) return [];

  const allowed = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.json', '.md', '.css', '.html', '.py', '.rs',
    '.go', '.java', '.cs', '.php', '.rb', '.yml',
    '.yaml', '.toml', '.sql', '.sh', '.ps1',
  ]);

  const out: string[] = [];
  const stack = [inputPath];
  while (stack.length && out.length < 80) {
    const current = stack.pop()!;
    if (shouldSkipPath(current)) continue;

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (shouldSkipPath(next)) continue;
      if (entry.isDirectory()) {
        stack.push(next);
      } else if (entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase())) {
        out.push(next);
      }
    }
  }
  return out;
}

function readContext(files: string[] | undefined, cwd: string): string {
  const requested = files ?? [];
  if (requested.length === 0) return '';

  const paths = Array.from(new Set(requested.flatMap(item => collectContextFiles(resolveCliPath(item, cwd)))));
  const chunks: string[] = [];
  let used = 0;
  const maxChars = 60000;

  for (const filePath of paths) {
    if (used >= maxChars) break;
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const relative = path.relative(cwd, filePath) || filePath;
      const remaining = maxChars - used;
      const body = text.length > remaining ? text.slice(0, remaining) : text;
      chunks.push(`--- ${relative} ---\n${body}`);
      used += body.length;
    } catch {}
  }

  return chunks.length ? `\n\nProject context:\n${chunks.join('\n\n')}` : '';
}

function truncate(value: string, max = 12000): string {
  return value.length > max ? `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]` : value;
}

function resolveAgentPath(value: unknown, cwd: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('path is required');
  const resolved = resolveCliPath(value.trim(), cwd);
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to access path outside workspace: ${value}`);
  }
  return resolved;
}

function allowedTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.css',
    '.html', '.py', '.rs', '.go', '.java', '.cs', '.php', '.rb', '.yml',
    '.yaml', '.toml', '.sql', '.sh', '.ps1', '.txt', '.env', '.example',
  ].includes(ext) || ['Dockerfile', 'Makefile', '.gitignore'].includes(path.basename(filePath));
}

function listAgentFiles(target: string, cwd: string, max = 200): string {
  const root = resolveAgentPath(target || '.', cwd);
  if (!fs.existsSync(root)) return `Path not found: ${path.relative(cwd, root)}`;
  if (fs.statSync(root).isFile()) return path.relative(cwd, root);

  const rows: string[] = [];
  const stack = [root];
  while (stack.length && rows.length < max) {
    const current = stack.pop()!;
    if (shouldSkipPath(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (shouldSkipPath(next)) continue;
      const relative = path.relative(cwd, next);
      if (entry.isDirectory()) {
        rows.push(`${relative}/`);
        stack.push(next);
      } else {
        rows.push(relative);
      }
      if (rows.length >= max) break;
    }
  }
  return rows.join('\n') || '(empty)';
}

function readAgentFile(filePath: string, cwd: string, startLine = 1, maxLines = 240): string {
  const resolved = resolveAgentPath(filePath, cwd);
  if (!fs.existsSync(resolved)) return `File not found: ${filePath}`;
  if (!fs.statSync(resolved).isFile()) return `Not a file: ${filePath}`;
  if (!allowedTextFile(resolved)) return `Refusing to read non-text file: ${filePath}`;

  const lines = fs.readFileSync(resolved, 'utf8').split(/\r?\n/);
  const start = Math.max(1, startLine);
  const end = Math.min(lines.length, start + Math.max(1, maxLines) - 1);
  return lines
    .slice(start - 1, end)
    .map((line, index) => `${String(start + index).padStart(4, ' ')} | ${line}`)
    .join('\n');
}

function searchAgentFiles(query: string, target: string, cwd: string, max = 80): string {
  if (!query) throw new Error('query is required');
  const root = resolveAgentPath(target || '.', cwd);
  if (!fs.existsSync(root)) return `Path not found: ${target}`;

  const files = collectContextFiles(root);
  const rows: string[] = [];
  const needle = query.toLowerCase();
  for (const file of files) {
    if (rows.length >= max) break;
    try {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          rows.push(`${path.relative(cwd, file)}:${i + 1}: ${lines[i].trim()}`);
          if (rows.length >= max) break;
        }
      }
    } catch {}
  }
  return rows.join('\n') || '(no matches)';
}

function summarizeDiff(before: string, after: string, fileLabel: string): string {
  if (before === after) return `No changes in ${fileLabel}.`;
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix + prefix < a.length
    && suffix + prefix < b.length
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;

  const beforeChunk = a.slice(prefix, Math.max(prefix, a.length - suffix)).slice(0, 40);
  const afterChunk = b.slice(prefix, Math.max(prefix, b.length - suffix)).slice(0, 40);
  return [
    `Diff preview for ${fileLabel} around line ${prefix + 1}:`,
    ...beforeChunk.map(line => `- ${line}`),
    ...afterChunk.map(line => `+ ${line}`),
  ].join('\n');
}

async function confirmAction(rl: readline.Interface, label: string, details: string, assumedYes?: boolean): Promise<boolean> {
  if (assumedYes) return true;
  console.log(chalk.yellow(`\nApproval required: ${label}`));
  console.log(truncate(details, 6000));
  const answer = (await rl.question(chalk.cyan('Run this action? [y/N] '))).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function parseToolCall(raw: string): AgentToolCall | null {
  const trimmed = raw.trim();
  const unwrapped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const candidates = [unwrapped];
  const firstBrace = unwrapped.indexOf('{');
  const lastBrace = unwrapped.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(unwrapped.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && typeof parsed.tool === 'string') {
        return { tool: parsed.tool, reason: parsed.reason, args: parsed.args ?? {} } as AgentToolCall;
      }
    } catch {}
  }
  return null;
}

function formatToolResult(tool: AgentToolName, ok: boolean, outputText: string): string {
  return JSON.stringify({
    tool_result: {
      tool,
      ok,
      output: truncate(outputText, 16000),
    },
  });
}

async function runAgentTool(call: AgentToolCall, options: AgentOptions, rl: readline.Interface): Promise<string> {
  const args = call.args ?? {};
  const cwd = options.cwd;
  try {
    switch (call.tool) {
      case 'list_files': {
        const target = typeof args.path === 'string' ? args.path : '.';
        return formatToolResult(call.tool, true, listAgentFiles(target, cwd, Number(args.max ?? 200)));
      }
      case 'read_file': {
        return formatToolResult(call.tool, true, readAgentFile(
          String(args.path ?? ''),
          cwd,
          Number(args.startLine ?? args.start_line ?? 1),
          Number(args.maxLines ?? args.max_lines ?? 240),
        ));
      }
      case 'search': {
        return formatToolResult(call.tool, true, searchAgentFiles(
          String(args.query ?? ''),
          typeof args.path === 'string' ? args.path : '.',
          cwd,
          Number(args.max ?? 80),
        ));
      }
      case 'replace_in_file': {
        const resolved = resolveAgentPath(args.path, cwd);
        const search = String(args.search ?? '');
        const replacement = String(args.replace ?? '');
        if (!search) throw new Error('search is required');
        if (!fs.existsSync(resolved)) throw new Error(`File not found: ${args.path}`);
        const before = fs.readFileSync(resolved, 'utf8');
        if (!before.includes(search)) throw new Error('Exact search text not found');
        const after = args.all === true ? before.split(search).join(replacement) : before.replace(search, replacement);
        const diff = summarizeDiff(before, after, path.relative(cwd, resolved));
        const ok = await confirmAction(rl, `edit ${path.relative(cwd, resolved)}`, diff, options.yes);
        if (!ok) return formatToolResult(call.tool, false, 'User rejected edit.');
        fs.writeFileSync(resolved, after, 'utf8');
        return formatToolResult(call.tool, true, diff);
      }
      case 'write_file': {
        const resolved = resolveAgentPath(args.path, cwd);
        const content = String(args.content ?? '');
        const before = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : '';
        const diff = summarizeDiff(before, content, path.relative(cwd, resolved));
        const ok = await confirmAction(rl, `write ${path.relative(cwd, resolved)}`, diff, options.yes);
        if (!ok) return formatToolResult(call.tool, false, 'User rejected write.');
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, 'utf8');
        return formatToolResult(call.tool, true, diff);
      }
      case 'run_command': {
        const command = String(args.command ?? '');
        if (!command) throw new Error('command is required');
        const ok = await confirmAction(rl, `run command`, `${cwd}> ${command}`, options.yes);
        if (!ok) return formatToolResult(call.tool, false, 'User rejected command.');
        const outputText = execSync(command, {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: Number(args.timeoutMs ?? args.timeout_ms ?? 120000),
        });
        return formatToolResult(call.tool, true, outputText || '(command completed with no output)');
      }
      case 'finish':
        return formatToolResult(call.tool, true, String(args.message ?? call.reason ?? 'Done.'));
      default:
        return formatToolResult(call.tool, false, `Unknown tool: ${call.tool}`);
    }
  } catch (error: any) {
    return formatToolResult(call.tool, false, error.message ?? String(error));
  }
}

async function runOneShotChat(prompt: string, systemPrompt: string, cmd: any) {
  const options = program.opts<CliOptions>();
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  try {
    await postChatCompletion(messages, {
      model: cmd.model,
      temperature: Number(cmd.temperature),
      maxTokens: Number(cmd.maxTokens),
      stream: cmd.stream,
    }, options);
  } catch (error: any) {
    console.error(chalk.red(`LLM-Hub request failed: ${error.message}`));
    console.error(chalk.gray(`Make sure the server is running: llm-hub start`));
    process.exit(1);
  }
}

async function runInteractiveChat(systemPrompt: string, cmd: any) {
  const options = program.opts<CliOptions>();
  const rl = readline.createInterface({ input, output });
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

  console.log(chalk.bold.blue('LLM-Hub terminal chat'));
  console.log(chalk.gray('Type /exit to quit, /clear to reset, /models to list routable models.\n'));

  try {
    while (true) {
      const prompt = (await rl.question(chalk.cyan('you> '))).trim();
      if (!prompt) continue;
      if (prompt === '/exit' || prompt === '/quit') break;
      if (prompt === '/clear') {
        messages.splice(1);
        console.log(chalk.gray('Conversation cleared.'));
        continue;
      }
      if (prompt === '/models') {
        const data = await apiRequest<{ data: Array<{ id: string; owned_by?: string }> }>('/v1/models', options);
        console.table(data.data.slice(0, 30).map(item => ({ model: item.id, provider: item.owned_by ?? '' })));
        continue;
      }

      messages.push({ role: 'user', content: prompt });
      process.stdout.write(chalk.green('assistant> '));
      const reply = await postChatCompletion(messages, {
        model: cmd.model,
        temperature: Number(cmd.temperature),
        maxTokens: Number(cmd.maxTokens),
        stream: cmd.stream,
      }, options);
      messages.push({ role: 'assistant', content: reply });
    }
  } catch (error: any) {
    console.error(chalk.red(`\nLLM-Hub chat failed: ${error.message}`));
    console.error(chalk.gray(`Make sure the server is running: llm-hub start`));
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

const AGENT_SYSTEM_PROMPT = `You are LLM-Hub Agent, a terminal coding agent.
You can inspect and modify the user's current workspace through tools.

Tool protocol:
Return exactly one JSON object when you need a tool, with this shape:
{"tool":"read_file","reason":"why","args":{"path":"relative/path.ts","startLine":1,"maxLines":200}}

Available tools:
- list_files: {"path":".","max":200}
- read_file: {"path":"file.ts","startLine":1,"maxLines":240}
- search: {"query":"text","path":".","max":80}
- replace_in_file: {"path":"file.ts","search":"exact old text","replace":"exact new text","all":false}
- write_file: {"path":"file.ts","content":"full file content"}
- run_command: {"command":"npm run build","timeoutMs":120000}
- finish: {"message":"final answer"}

Rules:
- Prefer reading/searching before editing.
- Use exact replace_in_file for small edits.
- Use write_file only for new files or full-file rewrites.
- Use run_command for tests/builds when useful.
- Explain concise progress in reason fields.
- Do not claim a command passed unless you ran it.
- When the work is done, call finish with a concise summary and verification.
- If you cannot proceed, call finish and explain the blocker.`;

async function runAgentTurn(task: string, options: AgentOptions, initialContext = ''): Promise<void> {
  const cliOptions = program.opts<CliOptions>();
  const rl = readline.createInterface({ input, output });
  const messages: ChatMessage[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Workspace: ${options.cwd}`,
        `Task: ${task}`,
        initialContext ? `Initial context:${initialContext}` : '',
      ].filter(Boolean).join('\n\n'),
    },
  ];

  try {
    for (let step = 1; step <= options.maxSteps; step++) {
      const reply = await postChatCompletion(messages, {
        model: options.model,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        stream: false,
      }, cliOptions);

      const call = parseToolCall(reply);
      if (!call) {
        console.log(chalk.green('agent> ') + reply);
        return;
      }

      if (call.tool === 'finish') {
        console.log(chalk.green('agent> ') + String(call.args?.message ?? call.reason ?? 'Done.'));
        return;
      }

      console.log(chalk.gray(`\n[${step}/${options.maxSteps}] ${call.tool}${call.reason ? ` - ${call.reason}` : ''}`));
      const result = await runAgentTool(call, options, rl);
      const parsedResult = JSON.parse(result);
      const resultText = parsedResult?.tool_result?.output ?? result;
      const ok = parsedResult?.tool_result?.ok;
      console.log(ok ? chalk.gray(truncate(resultText, 3000)) : chalk.red(truncate(resultText, 3000)));

      messages.push({ role: 'assistant', content: reply });
      messages.push({ role: 'user', content: result });
    }

    console.log(chalk.yellow(`Agent stopped after ${options.maxSteps} steps. Run again to continue.`));
  } catch (error: any) {
    console.error(chalk.red(`Agent failed: ${error.message}`));
    console.error(chalk.gray(`Make sure the server is running: llm-hub start`));
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

async function runInteractiveAgent(options: AgentOptions, initialContext = ''): Promise<void> {
  const rl = readline.createInterface({ input, output });
  console.log(chalk.bold.blue('LLM-Hub Agent'));
  console.log(chalk.gray('Type a coding task. /exit quits, /models lists routable models.\n'));

  try {
    while (true) {
      const task = (await rl.question(chalk.cyan('task> '))).trim();
      if (!task) continue;
      if (task === '/exit' || task === '/quit') break;
      if (task === '/clear') {
        console.log(chalk.gray('Agent session context cleared for future tasks.'));
        initialContext = '';
        continue;
      }
      if (task === '/models') {
        const cliOptions = program.opts<CliOptions>();
        const data = await apiRequest<{ data: Array<{ id: string; owned_by?: string }> }>('/v1/models', cliOptions);
        console.table(data.data.slice(0, 30).map(item => ({ model: item.id, provider: item.owned_by ?? '' })));
        continue;
      }
      await runAgentTurn(task, options, initialContext);
    }
  } finally {
    rl.close();
  }
}

const program = new Command();

program
  .name('llm-hub')
  .description('LLM-Hub Pro Max CLI for the local AI routing hub')
  .version(pkg.version, '-V, --version', 'Display version number')
  .option('-s, --server <url>', 'LLM-Hub server URL', DEFAULT_SERVER_URL);

program
  .command('install')
  .description('Interactive setup: create .env, install deps, and generate a local encryption key')
  .action(async () => {
    console.log(chalk.bold.blue('LLM-Hub Pro Max setup\n'));

    const envPath = path.join(rootDir, '.env');
    if (fs.existsSync(envPath)) {
      console.log(chalk.yellow('.env already exists. Skipping creation.'));
    } else {
      const key = randomBytes(32).toString('hex');
      fs.writeFileSync(envPath, `# Server encryption key for API key storage
ENCRYPTION_KEY=${key}

# Server port (default: 3001)
PORT=3001
`);
      console.log(chalk.green('Created .env with a random encryption key.'));
    }

    if (fs.existsSync(builtServerEntry) && fs.existsSync(builtClientEntry)) {
      console.log(chalk.green('Production server and dashboard build found.'));
    } else {
      console.log(chalk.blue('\nInstalling dependencies and building the app...'));
      try {
        execSync('npm install', { cwd: rootDir, stdio: 'inherit' });
        execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });
        console.log(chalk.green('Dependencies installed and app built.'));
      } catch (e) {
        console.error(chalk.red('Failed to install dependencies or build the app.'), e);
        process.exit(1);
      }
    }

    console.log(chalk.green('\nLLM-Hub Pro Max is ready. Run `llm-hub start` to launch.'));
  });

program
  .command('start')
  .description('Start the LLM-Hub server and dashboard')
  .action(() => {
    console.log(chalk.blue('Starting LLM-Hub Pro Max...'));
    try {
      if (fs.existsSync(builtServerEntry) && fs.existsSync(builtClientEntry)) {
        execSync(`node "${builtServerEntry}"`, { cwd: rootDir, stdio: 'inherit' });
      } else {
        execSync('npm run dev', { cwd: rootDir, stdio: 'inherit' });
      }
    } catch (e) {
      console.error(chalk.red('Failed to start.'), e);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Check if the server is running')
  .action(async () => {
    const ora = (await import('ora')).default;
    const options = program.opts<CliOptions>();
    const spinner = ora('Checking LLM-Hub status...').start();
    try {
      const data = await apiRequest('/api/ping', options);
      spinner.succeed(chalk.green(`Server is running at ${serverUrl(options)}`));
      printJson(data);
    } catch (error: any) {
      spinner.fail(chalk.red(`Server is not responding at ${serverUrl(options)}: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('config')
  .description('Open the .env file in your default editor')
  .action(() => {
    const editor = process.env.EDITOR || 'notepad';
    const envPath = path.join(rootDir, '.env');
    console.log(chalk.blue(`Opening ${envPath} in ${editor}...`));
    execSync(`${editor} "${envPath}"`, { stdio: 'inherit' });
  });

program
  .command('models')
  .description('List model catalog entries or OpenAI-compatible /v1/models output')
  .option('-p, --provider <platform>', 'filter by provider platform')
  .option('--enabled', 'only show enabled catalog models')
  .option('--configured', 'only show models with at least one enabled key for the provider')
  .option('--routable', 'query /v1/models instead of /api/models')
  .option('-l, --limit <count>', 'maximum rows to print', '100')
  .option('--json', 'print raw JSON')
  .action(async (cmd) => {
    const options = program.opts<CliOptions>();
    try {
      if (cmd.routable) {
        const data = await apiRequest<{ data: Array<{ id: string; owned_by?: string }> }>('/v1/models', options);
        let rows = data.data.map(item => ({ model: item.id, provider: item.owned_by ?? '' }));
        if (cmd.provider) rows = rows.filter(row => row.provider === cmd.provider || row.model.startsWith(`${cmd.provider}/`));
        rows = rows.slice(0, Number(cmd.limit));
        printRows(rows, cmd.json);
        return;
      }

      const data = await apiRequest<any[]>('/api/models', options);
      let rows = data;
      if (cmd.provider) rows = rows.filter(row => row.platform === cmd.provider);
      if (cmd.enabled) rows = rows.filter(row => row.enabled);
      if (cmd.configured) rows = rows.filter(row => row.keyCount > 0);
      rows = rows.slice(0, Number(cmd.limit));

      printRows(rows.map(row => ({
        id: row.id,
        provider: row.platform,
        model: row.modelId,
        name: row.displayName,
        enabled: bool(row.enabled),
        fallback: bool(row.fallbackEnabled),
        keys: row.keyCount,
      })), cmd.json);
    } catch (error: any) {
      console.error(chalk.red(`Failed to list models: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('providers')
  .description('List configured provider integrations and key counts')
  .option('--json', 'print raw JSON')
  .action(async (cmd) => {
    const options = program.opts<CliOptions>();
    try {
      const data = await apiRequest<{ providers: any[] }>('/api/models/providers', options);
      printRows(data.providers.map(provider => ({
        platform: provider.platform,
        name: provider.displayName,
        baseUrl: provider.apiBaseUrl,
        keyUrl: provider.keyUrl,
        docs: provider.docsUrl,
      })), cmd.json);
    } catch (error: any) {
      console.error(chalk.red(`Failed to list providers: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('ask [prompt...]')
  .description('Ask the routed models one question from the terminal')
  .option('-m, --model <model>', 'model id to use; omit or use auto for router selection', 'auto')
  .option('-t, --temperature <number>', 'sampling temperature', '0.4')
  .option('--max-tokens <number>', 'maximum output tokens', '1200')
  .option('--no-stream', 'disable streaming output')
  .action(async (promptParts, cmd) => {
    let prompt = joinPrompt(promptParts);
    if (!prompt && !process.stdin.isTTY) {
      prompt = await new Promise<string>((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { data += chunk; });
        process.stdin.on('end', () => resolve(data.trim()));
      });
    }

    if (!prompt) {
      console.error(chalk.red('No prompt provided.'));
      console.error(chalk.gray('Example: llm-hub ask "explain this error"'));
      process.exit(1);
    }

    await runOneShotChat(prompt, 'You are a concise, practical AI assistant.', cmd);
  });

program
  .command('chat [prompt...]')
  .description('Start an interactive terminal chat using the local routing layer')
  .option('-m, --model <model>', 'model id to use; omit or use auto for router selection', 'auto')
  .option('-t, --temperature <number>', 'sampling temperature', '0.4')
  .option('--max-tokens <number>', 'maximum output tokens per reply', '1600')
  .option('--system <prompt>', 'override the system prompt')
  .option('--no-stream', 'disable streaming output')
  .action(async (promptParts, cmd) => {
    const systemPrompt = cmd.system || 'You are a helpful terminal AI assistant. Be direct, practical, and concise.';
    const prompt = joinPrompt(promptParts);
    if (prompt) {
      await runOneShotChat(prompt, systemPrompt, cmd);
    } else {
      await runInteractiveChat(systemPrompt, cmd);
    }
  });

program
  .command('code [prompt...]')
  .alias('agent')
  .description('OpenCode-style terminal coding agent with local file and command tools')
  .option('-m, --model <model>', 'model id to use; omit or use auto for router selection', 'auto')
  .option('-t, --temperature <number>', 'sampling temperature', '0.2')
  .option('--max-tokens <number>', 'maximum output tokens per reply', '2400')
  .option('-f, --file <path...>', 'include files or folders as context')
  .option('--cwd <path>', 'workspace directory for relative file paths', process.cwd())
  .option('--max-steps <number>', 'maximum tool steps per task', '20')
  .option('-y, --yes', 'approve file edits and commands without prompting')
  .action(async (promptParts, cmd) => {
    const cwd = resolveCliPath(cmd.cwd, process.cwd());
    const context = readContext(cmd.file, cwd);
    const agentOptions: AgentOptions = {
      model: cmd.model,
      temperature: Number(cmd.temperature),
      maxTokens: Number(cmd.maxTokens),
      cwd,
      yes: cmd.yes,
      maxSteps: Number(cmd.maxSteps),
      stream: false,
    };

    const prompt = joinPrompt(promptParts);
    if (prompt) {
      await runAgentTurn(prompt, agentOptions, context);
    } else {
      await runInteractiveAgent(agentOptions, context);
    }
  });

function addKeyCommands(parent: Command) {
  parent
    .command('list')
    .description('List provider API keys')
    .option('--json', 'print raw JSON')
    .action(async (cmd) => {
      const options = program.opts<CliOptions>();
      try {
        const data = await apiRequest<any[]>('/api/keys', options);
        printRows(data.map(key => ({
          id: key.id,
          provider: key.platform,
          label: key.label,
          key: key.maskedKey,
          status: key.status,
          enabled: bool(key.enabled),
        })), cmd.json);
      } catch (error: any) {
        console.error(chalk.red(`Failed to list keys: ${error.message}`));
        process.exit(1);
      }
    });

  parent
    .command('add <platform> <key>')
    .description('Add a provider API key')
    .option('-l, --label <label>', 'key label')
    .action(async (platform, key, cmd) => {
      const options = program.opts<CliOptions>();
      try {
        const data = await apiRequest('/api/keys', {
          ...options,
          method: 'POST',
          body: JSON.stringify({ platform, key, label: cmd.label }),
        });
        console.log(chalk.green(`Added ${platform} key.`));
        printJson(data);
      } catch (error: any) {
        console.error(chalk.red(`Failed to add key: ${error.message}`));
        process.exit(1);
      }
    });

  parent
    .command('delete <id>')
    .alias('remove')
    .description('Delete a provider API key')
    .action(async (id) => {
      const options = program.opts<CliOptions>();
      try {
        await apiRequest(`/api/keys/${id}`, { ...options, method: 'DELETE' });
        console.log(chalk.green(`Deleted key ${id}.`));
      } catch (error: any) {
        console.error(chalk.red(`Failed to delete key: ${error.message}`));
        process.exit(1);
      }
    });

  for (const enabled of [true, false]) {
    parent
      .command(`${enabled ? 'enable' : 'disable'} <id>`)
      .description(`${enabled ? 'Enable' : 'Disable'} a provider API key`)
      .action(async (id) => {
        const options = program.opts<CliOptions>();
        try {
          await apiRequest(`/api/keys/${id}`, {
            ...options,
            method: 'PATCH',
            body: JSON.stringify({ enabled }),
          });
          console.log(chalk.green(`${enabled ? 'Enabled' : 'Disabled'} key ${id}.`));
        } catch (error: any) {
          console.error(chalk.red(`Failed to update key: ${error.message}`));
          process.exit(1);
        }
      });
  }
}

addKeyCommands(program.command('keys').description('Manage provider API keys'));
addKeyCommands(program.command('apis').description('Alias for provider API key management'));

const mcp = program.command('mcp').description('Manage documentation/MCP-style integration helpers');

mcp
  .command('status')
  .description('Show Context7 documentation integration status')
  .action(async () => {
    const options = program.opts<CliOptions>();
    try {
      const [settings, knowledge] = await Promise.all([
        apiRequest('/api/settings/context7', options),
        apiRequest('/api/knowledge/status', options),
      ]);
      printJson({ context7: settings, knowledge });
    } catch (error: any) {
      console.error(chalk.red(`Failed to read MCP integration status: ${error.message}`));
      process.exit(1);
    }
  });

mcp
  .command('context7:set <apiKey>')
  .description('Configure the Context7 API key used by documentation checks')
  .action(async (apiKey) => {
    const options = program.opts<CliOptions>();
    try {
      const data = await apiRequest('/api/settings/context7', {
        ...options,
        method: 'PUT',
        body: JSON.stringify({ apiKey }),
      });
      console.log(chalk.green('Context7 API key configured.'));
      printJson(data);
    } catch (error: any) {
      console.error(chalk.red(`Failed to configure Context7: ${error.message}`));
      process.exit(1);
    }
  });

mcp
  .command('context7:clear')
  .description('Remove the stored Context7 API key')
  .action(async () => {
    const options = program.opts<CliOptions>();
    try {
      const data = await apiRequest('/api/settings/context7', { ...options, method: 'DELETE' });
      console.log(chalk.green('Context7 API key removed.'));
      printJson(data);
    } catch (error: any) {
      console.error(chalk.red(`Failed to clear Context7: ${error.message}`));
      process.exit(1);
    }
  });

mcp
  .command('sync-docs')
  .description('Run provider documentation sync/check through the configured Context7 integration')
  .action(async () => {
    const options = program.opts<CliOptions>();
    try {
      const data = await apiRequest('/api/knowledge/sync', { ...options, method: 'POST' });
      console.log(chalk.green('Documentation sync complete.'));
      printJson(data);
    } catch (error: any) {
      console.error(chalk.red(`Documentation sync failed: ${error.message}`));
      process.exit(1);
    }
  });

program.parseAsync();
