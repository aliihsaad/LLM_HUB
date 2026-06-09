import type { ReactNode } from 'react'

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="relative mb-6 overflow-hidden rounded-2xl border border-border/70 bg-card/85 p-5">
      <div className="relative z-10 min-w-0">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          Dashboard Console
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1.5 max-w-3xl text-sm text-muted-foreground leading-relaxed">{description}</p>
        )}
      </div>
      {actions && <div className="relative z-10 mt-4 flex items-center gap-2 shrink-0 flex-wrap">{actions}</div>}
      <div className="pointer-events-none absolute -right-20 -top-16 h-40 w-40 rounded-full bg-primary/15 blur-3xl" />
      <div className="pointer-events-none absolute -left-20 top-8 h-32 w-32 rounded-full bg-sky-400/10 blur-3xl" />
    </div>
  )
}
