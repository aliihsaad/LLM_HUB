#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

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
