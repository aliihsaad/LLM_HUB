import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { ProviderHelperLinks } from '@/components/provider-helper-links'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { CapabilitiesResponse, ModelCapability } from '../../../shared/types'

const capabilityLabels: Record<ModelCapability, string> = {
  chat: 'Chat',
  embeddings: 'Embeddings',
  vision: 'Vision',
  video: 'Video',
  images: 'Images',
  audio: 'Audio',
}

const statusClass = {
  configured: 'bg-emerald-500',
  missing_key: 'bg-amber-500',
  unsupported: 'bg-muted-foreground/20',
} as const

const statusText = {
  configured: 'Routable',
  missing_key: 'No key',
  unsupported: '-',
} as const

function LegendItem({ status, label }: { status: keyof typeof statusClass; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`size-2 rounded-full ${statusClass[status]}`} />
      <span>{label}</span>
    </div>
  )
}

function CapabilityCell({
  capability,
  supportedModels,
  status,
}: {
  capability: ModelCapability
  supportedModels: number
  status: 'configured' | 'missing_key' | 'unsupported'
}) {
  const label = capabilityLabels[capability]
  const title = status === 'configured'
    ? `${label}: ${supportedModels} model${supportedModels === 1 ? '' : 's'} configured`
    : status === 'missing_key'
      ? `${label}: ${supportedModels} model${supportedModels === 1 ? '' : 's'}, no key`
      : `${label}: not supported`

  return (
    <div className="flex items-center justify-end gap-2 tabular-nums" title={title}>
      <span className={`size-2 rounded-full ${statusClass[status]}`} aria-label={title} />
      <span className={status === 'unsupported' ? 'text-xs text-muted-foreground' : 'text-xs font-medium'}>
        {statusText[status]}
      </span>
      {supportedModels > 0 && (
        <span className="text-xs font-mono text-muted-foreground">{supportedModels}</span>
      )}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="px-3 py-3">
        <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
        <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  )
}

export default function CapabilitiesPage() {
  const { data, isLoading } = useQuery<CapabilitiesResponse>({
    queryKey: ['models', 'capabilities'],
    queryFn: () => apiFetch('/api/models/capabilities'),
  })

  const capabilities = data?.capabilities ?? (['chat', 'embeddings', 'vision', 'video', 'images', 'audio'] as ModelCapability[])
  const providers = data?.providers ?? []
  const providerCount = providers.length
  const keyCount = providers.reduce((acc, provider) => acc + provider.keyCount, 0)
  const capable = providers.reduce((acc, provider) => {
    const configured = Object.values(provider.capabilities).filter(capability => capability.status === 'configured').length
    return acc + configured
  }, 0)
  const routableProviders = providers.filter(provider =>
    Object.values(provider.capabilities).some(capability => capability.status === 'configured'),
  ).length

  return (
    <div>
      <PageHeader
        title="Capabilities"
        description="Provider support and configured-key status by endpoint."
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label="Providers" value={providerCount} />
        <StatCard label="Keys configured" value={keyCount} />
        <StatCard label="Configured capabilities" value={capable} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Provider capability matrix</CardTitle>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <LegendItem status="configured" label="Supported with routable key" />
            <LegendItem status="missing_key" label="Supported, no key" />
            <LegendItem status="unsupported" label="Not supported" />
          </div>
          <p className="text-xs text-muted-foreground">
            {routableProviders} provider{routableProviders === 1 ? '' : 's'} routable · {keyCount} keys attached
          </p>
        </CardHeader>
        <CardContent>
          <div className="-mx-4 max-h-[560px] overflow-y-auto px-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead className="text-right">Keys</TableHead>
                  {capabilities.map(capability => (
                    <TableHead key={capability} className="text-right">
                      {capabilityLabels[capability]}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={capabilities.length + 2} className="text-sm text-muted-foreground">
                      Loading...
                    </TableCell>
                  </TableRow>
                ) : providers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={capabilities.length + 2} className="text-sm text-muted-foreground">
                      No providers found.
                    </TableCell>
                  </TableRow>
                ) : providers.map(provider => (
                  <TableRow key={provider.platform}>
                    <TableCell>
                      <div className="flex min-w-0 flex-col">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium">{provider.displayName}</span>
                          <ProviderHelperLinks provider={provider} compact />
                        </div>
                        <span className="text-xs text-muted-foreground font-mono">{provider.platform}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">{provider.keyCount}</TableCell>
                    {capabilities.map(capability => {
                      const light = provider.capabilities[capability]
                      return (
                        <TableCell key={capability} className="text-right">
                          <CapabilityCell
                            capability={capability}
                            supportedModels={light.supportedModels}
                            status={light.status}
                          />
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
