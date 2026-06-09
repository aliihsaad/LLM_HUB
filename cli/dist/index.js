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
function serverUrl(options) {
    return (options?.server ?? process.env.LLMHUB_SERVER_URL ?? DEFAULT_SERVER_URL).replace(/\/$/, '');
}
async function apiRequest(pathname, options = {}) {
    const { server, ...init } = options;
    const headers = new Headers(init.headers);
    if (init.body && !headers.has('Content-Type'))
        headers.set('Content-Type', 'application/json');
    const res = await fetch(`${serverUrl({ server })}${pathname}`, { ...init, headers });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
        const message = data?.error?.message ?? data?.message ?? `HTTP ${res.status}`;
        throw new Error(message);
    }
    return data;
}
function bool(value) {
    return value ? 'yes' : 'no';
}
function printJson(value) {
    console.log(JSON.stringify(value, null, 2));
}
function printRows(rows, json) {
    if (json) {
        printJson(rows);
        return;
    }
    console.table(rows);
}
function cleanModel(model) {
    if (!model || model === 'auto')
        return undefined;
    return model;
}
function compactText(value) {
    return typeof value === 'string' ? value : '';
}
async function postChatCompletion(messages, requestOptions, cliOptions) {
    const body = {
        messages,
        temperature: requestOptions.temperature,
        max_tokens: requestOptions.maxTokens,
        stream: requestOptions.stream ?? true,
    };
    const model = cleanModel(requestOptions.model);
    if (model)
        body.model = model;
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
        }
        catch { }
        throw new Error(message || `HTTP ${res.status}`);
    }
    if (!requestOptions.stream) {
        const payload = await res.json();
        return compactText(payload?.choices?.[0]?.message?.content);
    }
    if (!res.body)
        throw new Error('No response body from server.');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    while (true) {
        const chunk = await reader.read();
        if (chunk.done)
            break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:'))
                continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === '[DONE]')
                continue;
            try {
                const parsed = JSON.parse(data);
                const delta = compactText(parsed?.choices?.[0]?.delta?.content);
                const message = compactText(parsed?.choices?.[0]?.message?.content);
                const text = delta || message;
                if (text) {
                    fullText += text;
                    process.stdout.write(text);
                }
            }
            catch {
                // Ignore malformed provider frames; the proxy may still continue.
            }
        }
    }
    process.stdout.write('\n');
    return fullText;
}
function joinPrompt(parts) {
    return (parts ?? []).join(' ').trim();
}
function resolveCliPath(value, cwd) {
    return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}
function shouldSkipPath(filePath) {
    const parts = filePath.split(/[\\/]/);
    return parts.some(part => ['.git', 'node_modules', 'dist', 'data', '.next', 'coverage'].includes(part));
}
function collectContextFiles(inputPath) {
    if (!fs.existsSync(inputPath) || shouldSkipPath(inputPath))
        return [];
    const stat = fs.statSync(inputPath);
    if (stat.isFile())
        return [inputPath];
    if (!stat.isDirectory())
        return [];
    const allowed = new Set([
        '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
        '.json', '.md', '.css', '.html', '.py', '.rs',
        '.go', '.java', '.cs', '.php', '.rb', '.yml',
        '.yaml', '.toml', '.sql', '.sh', '.ps1',
    ]);
    const out = [];
    const stack = [inputPath];
    while (stack.length && out.length < 80) {
        const current = stack.pop();
        if (shouldSkipPath(current))
            continue;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const next = path.join(current, entry.name);
            if (shouldSkipPath(next))
                continue;
            if (entry.isDirectory()) {
                stack.push(next);
            }
            else if (entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase())) {
                out.push(next);
            }
        }
    }
    return out;
}
function readContext(files, cwd) {
    const requested = files ?? [];
    if (requested.length === 0)
        return '';
    const paths = Array.from(new Set(requested.flatMap(item => collectContextFiles(resolveCliPath(item, cwd)))));
    const chunks = [];
    let used = 0;
    const maxChars = 60000;
    for (const filePath of paths) {
        if (used >= maxChars)
            break;
        try {
            const text = fs.readFileSync(filePath, 'utf8');
            const relative = path.relative(cwd, filePath) || filePath;
            const remaining = maxChars - used;
            const body = text.length > remaining ? text.slice(0, remaining) : text;
            chunks.push(`--- ${relative} ---\n${body}`);
            used += body.length;
        }
        catch { }
    }
    return chunks.length ? `\n\nProject context:\n${chunks.join('\n\n')}` : '';
}
async function runOneShotChat(prompt, systemPrompt, cmd) {
    const options = program.opts();
    const messages = [
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
    }
    catch (error) {
        console.error(chalk.red(`LLM-Hub request failed: ${error.message}`));
        console.error(chalk.gray(`Make sure the server is running: llm-hub start`));
        process.exit(1);
    }
}
async function runInteractiveChat(systemPrompt, cmd) {
    const options = program.opts();
    const rl = readline.createInterface({ input, output });
    const messages = [{ role: 'system', content: systemPrompt }];
    console.log(chalk.bold.blue('LLM-Hub terminal chat'));
    console.log(chalk.gray('Type /exit to quit, /clear to reset, /models to list routable models.\n'));
    try {
        while (true) {
            const prompt = (await rl.question(chalk.cyan('you> '))).trim();
            if (!prompt)
                continue;
            if (prompt === '/exit' || prompt === '/quit')
                break;
            if (prompt === '/clear') {
                messages.splice(1);
                console.log(chalk.gray('Conversation cleared.'));
                continue;
            }
            if (prompt === '/models') {
                const data = await apiRequest('/v1/models', options);
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
    }
    catch (error) {
        console.error(chalk.red(`\nLLM-Hub chat failed: ${error.message}`));
        console.error(chalk.gray(`Make sure the server is running: llm-hub start`));
        process.exitCode = 1;
    }
    finally {
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
    }
    else {
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
    }
    else {
        console.log(chalk.blue('\nInstalling dependencies and building the app...'));
        try {
            execSync('npm install', { cwd: rootDir, stdio: 'inherit' });
            execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });
            console.log(chalk.green('Dependencies installed and app built.'));
        }
        catch (e) {
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
        }
        else {
            execSync('npm run dev', { cwd: rootDir, stdio: 'inherit' });
        }
    }
    catch (e) {
        console.error(chalk.red('Failed to start.'), e);
        process.exit(1);
    }
});
program
    .command('status')
    .description('Check if the server is running')
    .action(async () => {
    const ora = (await import('ora')).default;
    const options = program.opts();
    const spinner = ora('Checking LLM-Hub status...').start();
    try {
        const data = await apiRequest('/api/ping', options);
        spinner.succeed(chalk.green(`Server is running at ${serverUrl(options)}`));
        printJson(data);
    }
    catch (error) {
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
    const options = program.opts();
    try {
        if (cmd.routable) {
            const data = await apiRequest('/v1/models', options);
            let rows = data.data.map(item => ({ model: item.id, provider: item.owned_by ?? '' }));
            if (cmd.provider)
                rows = rows.filter(row => row.provider === cmd.provider || row.model.startsWith(`${cmd.provider}/`));
            rows = rows.slice(0, Number(cmd.limit));
            printRows(rows, cmd.json);
            return;
        }
        const data = await apiRequest('/api/models', options);
        let rows = data;
        if (cmd.provider)
            rows = rows.filter(row => row.platform === cmd.provider);
        if (cmd.enabled)
            rows = rows.filter(row => row.enabled);
        if (cmd.configured)
            rows = rows.filter(row => row.keyCount > 0);
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
    }
    catch (error) {
        console.error(chalk.red(`Failed to list models: ${error.message}`));
        process.exit(1);
    }
});
program
    .command('providers')
    .description('List configured provider integrations and key counts')
    .option('--json', 'print raw JSON')
    .action(async (cmd) => {
    const options = program.opts();
    try {
        const data = await apiRequest('/api/models/providers', options);
        printRows(data.providers.map(provider => ({
            platform: provider.platform,
            name: provider.displayName,
            baseUrl: provider.apiBaseUrl,
            keyUrl: provider.keyUrl,
            docs: provider.docsUrl,
        })), cmd.json);
    }
    catch (error) {
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
        prompt = await new Promise((resolve) => {
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
    }
    else {
        await runInteractiveChat(systemPrompt, cmd);
    }
});
program
    .command('code [prompt...]')
    .alias('agent')
    .description('Coding-focused terminal assistant with optional file or folder context')
    .option('-m, --model <model>', 'model id to use; omit or use auto for router selection', 'auto')
    .option('-t, --temperature <number>', 'sampling temperature', '0.2')
    .option('--max-tokens <number>', 'maximum output tokens per reply', '2400')
    .option('-f, --file <path...>', 'include files or folders as context')
    .option('--cwd <path>', 'workspace directory for relative file paths', process.cwd())
    .option('--no-stream', 'disable streaming output')
    .action(async (promptParts, cmd) => {
    const cwd = resolveCliPath(cmd.cwd, process.cwd());
    const context = readContext(cmd.file, cwd);
    const systemPrompt = [
        'You are LLM-Hub Code, a terminal coding assistant.',
        'Answer like a senior pragmatic software engineer.',
        'When code changes are needed, be specific about files and exact edits.',
        'Do not invent file contents that were not provided; ask for file context when needed.',
    ].join(' ');
    const prompt = joinPrompt(promptParts);
    if (prompt) {
        await runOneShotChat(`${prompt}${context}`, systemPrompt, cmd);
    }
    else {
        const withContext = context
            ? `${systemPrompt}\n\nUse this initial project context for the session.${context}`
            : systemPrompt;
        await runInteractiveChat(withContext, cmd);
    }
});
function addKeyCommands(parent) {
    parent
        .command('list')
        .description('List provider API keys')
        .option('--json', 'print raw JSON')
        .action(async (cmd) => {
        const options = program.opts();
        try {
            const data = await apiRequest('/api/keys', options);
            printRows(data.map(key => ({
                id: key.id,
                provider: key.platform,
                label: key.label,
                key: key.maskedKey,
                status: key.status,
                enabled: bool(key.enabled),
            })), cmd.json);
        }
        catch (error) {
            console.error(chalk.red(`Failed to list keys: ${error.message}`));
            process.exit(1);
        }
    });
    parent
        .command('add <platform> <key>')
        .description('Add a provider API key')
        .option('-l, --label <label>', 'key label')
        .action(async (platform, key, cmd) => {
        const options = program.opts();
        try {
            const data = await apiRequest('/api/keys', {
                ...options,
                method: 'POST',
                body: JSON.stringify({ platform, key, label: cmd.label }),
            });
            console.log(chalk.green(`Added ${platform} key.`));
            printJson(data);
        }
        catch (error) {
            console.error(chalk.red(`Failed to add key: ${error.message}`));
            process.exit(1);
        }
    });
    parent
        .command('delete <id>')
        .alias('remove')
        .description('Delete a provider API key')
        .action(async (id) => {
        const options = program.opts();
        try {
            await apiRequest(`/api/keys/${id}`, { ...options, method: 'DELETE' });
            console.log(chalk.green(`Deleted key ${id}.`));
        }
        catch (error) {
            console.error(chalk.red(`Failed to delete key: ${error.message}`));
            process.exit(1);
        }
    });
    for (const enabled of [true, false]) {
        parent
            .command(`${enabled ? 'enable' : 'disable'} <id>`)
            .description(`${enabled ? 'Enable' : 'Disable'} a provider API key`)
            .action(async (id) => {
            const options = program.opts();
            try {
                await apiRequest(`/api/keys/${id}`, {
                    ...options,
                    method: 'PATCH',
                    body: JSON.stringify({ enabled }),
                });
                console.log(chalk.green(`${enabled ? 'Enabled' : 'Disabled'} key ${id}.`));
            }
            catch (error) {
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
    const options = program.opts();
    try {
        const [settings, knowledge] = await Promise.all([
            apiRequest('/api/settings/context7', options),
            apiRequest('/api/knowledge/status', options),
        ]);
        printJson({ context7: settings, knowledge });
    }
    catch (error) {
        console.error(chalk.red(`Failed to read MCP integration status: ${error.message}`));
        process.exit(1);
    }
});
mcp
    .command('context7:set <apiKey>')
    .description('Configure the Context7 API key used by documentation checks')
    .action(async (apiKey) => {
    const options = program.opts();
    try {
        const data = await apiRequest('/api/settings/context7', {
            ...options,
            method: 'PUT',
            body: JSON.stringify({ apiKey }),
        });
        console.log(chalk.green('Context7 API key configured.'));
        printJson(data);
    }
    catch (error) {
        console.error(chalk.red(`Failed to configure Context7: ${error.message}`));
        process.exit(1);
    }
});
mcp
    .command('context7:clear')
    .description('Remove the stored Context7 API key')
    .action(async () => {
    const options = program.opts();
    try {
        const data = await apiRequest('/api/settings/context7', { ...options, method: 'DELETE' });
        console.log(chalk.green('Context7 API key removed.'));
        printJson(data);
    }
    catch (error) {
        console.error(chalk.red(`Failed to clear Context7: ${error.message}`));
        process.exit(1);
    }
});
mcp
    .command('sync-docs')
    .description('Run provider documentation sync/check through the configured Context7 integration')
    .action(async () => {
    const options = program.opts();
    try {
        const data = await apiRequest('/api/knowledge/sync', { ...options, method: 'POST' });
        console.log(chalk.green('Documentation sync complete.'));
        printJson(data);
    }
    catch (error) {
        console.error(chalk.red(`Documentation sync failed: ${error.message}`));
        process.exit(1);
    }
});
program.parseAsync();
