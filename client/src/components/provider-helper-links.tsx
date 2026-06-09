import { ExternalLink, KeyRound } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ProviderMetadata } from '../../../shared/types'

interface ProviderHelperLinksProps {
  provider: Pick<ProviderMetadata, 'displayName' | 'docsUrl' | 'keyUrl'>
  compact?: boolean
  className?: string
}

export function ProviderHelperLinks({ provider, compact = false, className }: ProviderHelperLinksProps) {
  const linkClass = cn(
    buttonVariants({ variant: 'ghost', size: compact ? 'icon-xs' : 'xs' }),
    compact ? 'text-muted-foreground hover:text-foreground' : 'h-6 text-xs text-muted-foreground hover:text-foreground',
  )

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {provider.docsUrl && (
        <a
          className={linkClass}
          href={provider.docsUrl}
          target="_blank"
          rel="noreferrer"
          title={`${provider.displayName} API docs`}
          aria-label={`${provider.displayName} API docs`}
        >
          <ExternalLink data-icon="inline-start" className="size-3" aria-hidden="true" />
          {compact ? <span className="sr-only">Docs</span> : <span>Docs</span>}
        </a>
      )}
      {provider.keyUrl && (
        <a
          className={linkClass}
          href={provider.keyUrl}
          target="_blank"
          rel="noreferrer"
          title={`${provider.displayName} API key page`}
          aria-label={`${provider.displayName} API key page`}
        >
          <KeyRound data-icon="inline-start" className="size-3" aria-hidden="true" />
          {compact ? <span className="sr-only">Key</span> : <span>Key</span>}
        </a>
      )}
    </div>
  )
}
