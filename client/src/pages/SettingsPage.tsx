import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, LogOut, ShieldCheck, ShieldOff, BookOpen, Save, Trash2, AlertTriangle, Coins } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/page-header'

interface DashboardAuthStatus {
  pinEnabled: boolean
  authenticated: boolean
}

const CONTEXT7_API_URL = 'https://context7.com/api/v2'

interface Context7Config {
  configured: boolean
  apiUrl: string | null
  apiKey: string | null
}

export default function SettingsPage() {
  const queryClient = useQueryClient()
  const [pin, setPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [c7Key, setC7Key] = useState('')

  const { data } = useQuery<DashboardAuthStatus>({
    queryKey: ['auth', 'status'],
    queryFn: () => apiFetch('/api/auth/status'),
  })

  const { data: context7Data } = useQuery<Context7Config>({
    queryKey: ['settings', 'context7'],
    queryFn: () => apiFetch('/api/settings/context7'),
  })

  const { data: freeOnlyData } = useQuery<{ freeOnlyMode: boolean }>({
    queryKey: ['settings', 'free-only-mode'],
    queryFn: () => apiFetch('/api/settings/free-only-mode'),
  })
  const freeOnlyMode = freeOnlyData?.freeOnlyMode ?? true

  const setFreeOnly = useMutation({
    mutationFn: (enabled: boolean) =>
      apiFetch<{ freeOnlyMode: boolean }>('/api/settings/free-only-mode', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings', 'free-only-mode'] }),
  })

  const refreshAuth = () => {
    queryClient.invalidateQueries({ queryKey: ['auth', 'status'] })
  }

  const refreshContext7 = () => {
    queryClient.invalidateQueries({ queryKey: ['settings', 'context7'] })
  }

  const enablePin = useMutation({
    mutationFn: () =>
      apiFetch<DashboardAuthStatus>('/api/auth/config', {
        method: 'PUT',
        body: JSON.stringify({ enabled: true, pin }),
      }),
    onSuccess: () => {
      setPin('')
      refreshAuth()
    },
  })

  const changePin = useMutation({
    mutationFn: () =>
      apiFetch<DashboardAuthStatus>('/api/auth/config', {
        method: 'PUT',
        body: JSON.stringify({ enabled: true, pin: newPin }),
      }),
    onSuccess: () => {
      setNewPin('')
      refreshAuth()
    },
  })

  const disablePin = useMutation({
    mutationFn: () =>
      apiFetch<DashboardAuthStatus>('/api/auth/config', {
        method: 'PUT',
        body: JSON.stringify({ enabled: false }),
      }),
    onSuccess: refreshAuth,
  })

  const logout = useMutation({
    mutationFn: () => apiFetch<DashboardAuthStatus>('/api/auth/logout', { method: 'POST' }),
    onSuccess: refreshAuth,
  })

  const saveContext7 = useMutation({
    mutationFn: () =>
      apiFetch('/api/settings/context7', {
        method: 'PUT',
        body: JSON.stringify({ apiKey: c7Key }),
      }),
    onSuccess: () => {
      setC7Key('')
      refreshContext7()
    },
  })

  const removeContext7 = useMutation({
    mutationFn: () => apiFetch('/api/settings/context7', { method: 'DELETE' }),
    onSuccess: refreshContext7,
  })

  const pinEnabled = data?.pinEnabled ?? false
  const c7Configured = context7Data?.configured ?? false
  const error = enablePin.error ?? changePin.error ?? disablePin.error ?? logout.error ?? saveContext7.error ?? removeContext7.error ?? setFreeOnly.error

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Dashboard access controls, routing policy, and integrations." />

      {/* Free-tier only */}
      <Card className="rounded-lg">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Coins className="size-5" />
                Free-tier only
              </CardTitle>
              <div className="mt-2 flex items-center gap-2">
                <Badge variant={freeOnlyMode ? 'default' : 'secondary'}>
                  {freeOnlyMode ? 'On' : 'Off'}
                </Badge>
              </div>
            </div>
            <div className="flex size-9 items-center justify-center rounded-lg border bg-muted/40">
              <Coins
                className={`size-4 ${freeOnlyMode ? 'text-green-500' : 'text-muted-foreground'}`}
                aria-hidden="true"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            When on, paid models are hidden from <code>/v1/models</code>, blocked from routing with{' '}
            <code>403 paid_model_blocked</code>, and excluded from auto-routing, the fallback chain,
            and the health sweep — so no request can spend paid credit. Turn it off to allow paid
            models (they stay marked <span className="font-semibold text-amber-500">paid</span> in the
            Playground). Default: on.
          </p>
          <Button
            variant={freeOnlyMode ? 'outline' : 'default'}
            onClick={() => setFreeOnly.mutate(!freeOnlyMode)}
            disabled={setFreeOnly.isPending}
          >
            <Coins className="size-3.5" aria-hidden="true" />
            {setFreeOnly.isPending
              ? 'Saving...'
              : freeOnlyMode
                ? 'Allow paid models'
                : 'Restrict to free tier'}
          </Button>
        </CardContent>
      </Card>

      {/* Dashboard PIN */}
      <Card className="rounded-lg">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Dashboard PIN</CardTitle>
              <div className="mt-2 flex items-center gap-2">
                <Badge variant={pinEnabled ? 'default' : 'secondary'}>
                  {pinEnabled ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
            </div>
            <div className="flex size-9 items-center justify-center rounded-lg border bg-muted/40">
              {pinEnabled ? (
                <ShieldCheck className="size-4" aria-hidden="true" />
              ) : (
                <ShieldOff className="size-4" aria-hidden="true" />
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {!pinEnabled ? (
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                enablePin.mutate()
              }}
            >
              <div className="min-w-[220px] flex-1 space-y-1.5">
                <Label className="text-xs" htmlFor="enable-dashboard-pin">New PIN</Label>
                <Input
                  id="enable-dashboard-pin"
                  type="password"
                  value={pin}
                  onChange={event => setPin(event.target.value)}
                  autoComplete="new-password"
                  className="font-mono"
                />
              </div>
              <Button type="submit" disabled={pin.trim().length < 4 || enablePin.isPending}>
                <KeyRound className="size-3.5" aria-hidden="true" />
                {enablePin.isPending ? 'Enabling...' : 'Enable PIN'}
              </Button>
            </form>
          ) : (
            <div className="space-y-5">
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  changePin.mutate()
                }}
              >
                <div className="min-w-[220px] flex-1 space-y-1.5">
                  <Label className="text-xs" htmlFor="change-dashboard-pin">New PIN</Label>
                  <Input
                    id="change-dashboard-pin"
                    type="password"
                    value={newPin}
                    onChange={event => setNewPin(event.target.value)}
                    autoComplete="new-password"
                    className="font-mono"
                  />
                </div>
                <Button type="submit" variant="outline" disabled={newPin.trim().length < 4 || changePin.isPending}>
                  <KeyRound className="size-3.5" aria-hidden="true" />
                  {changePin.isPending ? 'Changing...' : 'Change PIN'}
                </Button>
              </form>

              <div className="flex flex-wrap items-center gap-2 border-t pt-4">
                <Button variant="outline" onClick={() => logout.mutate()} disabled={logout.isPending}>
                  <LogOut className="size-3.5" aria-hidden="true" />
                  {logout.isPending ? 'Signing out...' : 'Sign out'}
                </Button>
                <Button variant="destructive" onClick={() => disablePin.mutate()} disabled={disablePin.isPending}>
                  <ShieldOff className="size-3.5" aria-hidden="true" />
                  {disablePin.isPending ? 'Disabling...' : 'Disable PIN'}
                </Button>
              </div>
            </div>
          )}

          {error && <p className="text-xs text-destructive">{(error as Error).message}</p>}
        </CardContent>
      </Card>

      {/* Context7 Configuration */}
      <Card className="rounded-lg">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="size-5" />
                Context7 Knowledge Base
              </CardTitle>
              <div className="mt-2 flex items-center gap-2">
                {c7Configured ? (
                  <Badge variant="default">Connected</Badge>
                ) : (
                  <Badge variant="secondary">Not Configured</Badge>
                )}
              </div>
            </div>
            <div className="flex size-9 items-center justify-center rounded-lg border bg-muted/40">
              {c7Configured ? (
                <BookOpen className="size-4 text-green-500" aria-hidden="true" />
              ) : (
                <AlertTriangle className="size-4 text-amber-500" aria-hidden="true" />
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {!c7Configured && (
            <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 p-4 border border-amber-200 dark:border-amber-800">
              <div className="flex items-start gap-3">
                <AlertTriangle className="size-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <div className="text-sm text-amber-800 dark:text-amber-200">
                  <p className="font-semibold mb-1">Context7 API Not Configured</p>
                  <p className="text-xs opacity-80">
                    Knowledge base is running with locally-seeded defaults. 
                    To enable live documentation updates, configure your Context7 API credentials below.
                  </p>
                </div>
              </div>
            </div>
          )}

          {c7Configured && (
            <div className="rounded-md bg-green-50 dark:bg-green-950/30 p-3 border border-green-200 dark:border-green-800">
              <p className="text-sm text-green-800 dark:text-green-200">
                <span className="font-semibold">Connected to:</span>{' '}
                {context7Data?.apiUrl ?? CONTEXT7_API_URL}
              </p>
            </div>
          )}

          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              saveContext7.mutate()
            }}
          >
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="context7-key">API Key</Label>
              <p className="text-xs text-muted-foreground">Endpoint: {CONTEXT7_API_URL}</p>
              <Input
                id="context7-key"
                type="password"
                placeholder="your-context7-api-key"
                value={c7Key}
                onChange={event => setC7Key(event.target.value)}
                className="font-mono"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                disabled={saveContext7.isPending || c7Key.trim().length === 0}
              >
                <Save className="size-3.5" aria-hidden="true" />
                {saveContext7.isPending ? 'Saving...' : 'Save Configuration'}
              </Button>
              {c7Configured && (
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => removeContext7.mutate()}
                  disabled={removeContext7.isPending}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  {removeContext7.isPending ? 'Removing...' : 'Remove'}
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
