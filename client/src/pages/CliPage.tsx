import { useState } from 'react'
import { Check, Clipboard, Terminal, TerminalSquare } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'

type CliCommand = {
  id: string
  title: string
  command: string
  description: string
}

const installCommands: CliCommand[] = [
  {
    id: 'install-deps',
    title: 'Install project dependencies',
    command: 'npm install',
    description: 'Install all workspace dependencies from the repository root.',
  },
  {
    id: 'install-build',
    title: 'Build CLI binaries',
    command: 'npm run build -w cli',
    description: 'Compiles the CLI entrypoint to `cli/dist/index.js`.',
  },
  {
    id: 'run-install-local',
    title: 'Run install flow (local checkout)',
    command: 'node cli/dist/index.js install',
    description: 'Creates `.env`, generates ENCRYPTION_KEY, and installs dependencies again from root.',
  },
]

const cliCommands: CliCommand[] = [
  {
    id: 'command-install',
    title: 'Install wizard',
    command: 'llm-hub install',
    description: 'Interactive setup for initial local `.env` and dependency refresh.',
  },
  {
    id: 'command-start',
    title: 'Start server + dashboard',
    command: 'llm-hub start',
    description: 'Runs the project dev stack locally.',
  },
  {
    id: 'command-status',
    title: 'Health check',
    command: 'llm-hub status',
    description: 'Checks `/api/health` and prints provider/key health state.',
  },
  {
    id: 'command-config',
    title: 'Open .env',
    command: 'llm-hub config',
    description: 'Open `.env` in your default editor.',
  },
  {
    id: 'command-version',
    title: 'Version',
    command: 'llm-hub --version',
    description: 'Print the installed CLI version.',
  },
]

function CopyButton({
  id,
  value,
  copiedId,
  onCopy,
}: {
  id: string
  value: string
  copiedId: string | null
  onCopy: (id: string, value: string) => void
}) {
  const copied = copiedId === id
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => onCopy(id, value)}
      className="h-8"
      aria-label="Copy command"
    >
      {copied ? <Check className="size-4 text-emerald-500" /> : <Clipboard className="size-4" />}
    </Button>
  )
}

function CliCommandCard({
  item,
  copiedId,
  onCopy,
}: {
  item: CliCommand
  copiedId: string | null
  onCopy: (id: string, value: string) => Promise<void>
}) {
  return (
    <Card className="rounded-lg">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm">{item.title}</CardTitle>
            <CardDescription className="mt-1">{item.description}</CardDescription>
          </div>
          <CopyButton id={item.id} value={item.command} copiedId={copiedId} onCopy={onCopy} />
        </div>
      </CardHeader>
      <CardContent>
        <pre className="overflow-x-auto rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-sm font-mono tabular-nums">
          {item.command}
        </pre>
      </CardContent>
    </Card>
  )
}

export default function CliPage() {
  const [copiedId, setCopiedId] = useState<string | null>(null)

  async function copyText(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedId(id)
      window.setTimeout(() => setCopiedId(current => (current === id ? null : current)), 1400)
    } catch {
      setCopiedId(null)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="CLI"
        description="Terminal commands for setup, run, and operational checks."
        actions={
          <Badge variant="outline" className="px-2 py-1">
            <TerminalSquare className="size-3.5 mr-1.5" />
            Command Center
          </Badge>
        }
      />

      <section className="space-y-4">
        <Card className="border-2 border-primary/20">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Terminal className="size-4 text-primary" />
              <CardTitle>Installation</CardTitle>
            </div>
            <CardDescription>
              One command to prepare the workspace, then build and run the CLI.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Use this if you are running from source or debugging installation behavior.
            </p>
            <div className="space-y-3">
              {installCommands.map(item => (
                <CliCommandCard key={item.id} item={item} copiedId={copiedId} onCopy={copyText} />
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Available Commands</CardTitle>
            <CardDescription>These are the currently wired CLI commands in this repository.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {cliCommands.map(item => (
              <CliCommandCard key={item.id} item={item} copiedId={copiedId} onCopy={copyText} />
            ))}
          </CardContent>
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground">
              Tip: for iterative CLI testing, run the CLI directly with{' '}
              <code className="rounded bg-muted px-1.5 py-0.5">npm --prefix cli run dev</code>.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
