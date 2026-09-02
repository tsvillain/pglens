import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMatchRoute, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Copy, PanelRightClose, Settings, Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import {
  generateNlSql, getAiConfig, setAiConfig,
  type AiConfig, type AiConfigPayload, type NlSqlResult,
} from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { useAiPanelStore } from '@/store/aiPanel'
import { useConnectionStore } from '@/store/connection'
import { useQuerySeedStore } from '@/store/querySeed'
import { useTabsStore } from '@/store/tabs'

/**
 * AI mode — schema-aware NL→SQL (roadmap §7.6).
 *
 * A chat box in the sidebar: the user describes what they want, the server
 * grounds the prompt on the live schema + sample rows + recent history and
 * returns SQL. The SQL is shown here and is handed to the Query editor (the
 * existing Advanced-mode console) where it's editable and runnable — so it's
 * always reviewed before it runs. Read-only by default; writes are opt-in.
 *
 * ponytail: reuses the querySeed → QueryRunner hand-off the slow-query
 * drilldown already uses, so there's no new editor/runner surface. "Save as
 * view" (roadmap §7.6) is reached through the editor's existing Save action
 * rather than a bespoke flow.
 *
 * Mounted as the right rail in the root layout. It reads the active connection
 * and the open table itself (for sample-row grounding) so the layout only has
 * to drop it in.
 */
export function AiPanel() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const matchRoute = useMatchRoute()
  const connectionId = useConnectionStore((s) => s.activeConnectionId)
  const tableMatch = matchRoute({ to: '/tables/$tableName' }) as
    | { tableName: string }
    | false
  const focusTable = tableMatch ? tableMatch.tableName : undefined
  const setSeed = useQuerySeedStore((s) => s.setSeed)
  const openTab = useTabsStore((s) => s.open)
  const collapsed = useAiPanelStore((s) => s.collapsed)
  const setCollapsed = useAiPanelStore((s) => s.setCollapsed)

  const config = useQuery({
    queryKey: ['ai-config'],
    queryFn: ({ signal }) => getAiConfig(signal),
    staleTime: 30_000,
  })

  const [prompt, setPrompt] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [result, setResult] = useState<NlSqlResult | null>(null)

  const generate = useMutation({
    // connectionId is non-null whenever the rail renders (gated below).
    mutationFn: () =>
      generateNlSql(connectionId as string, prompt.trim(), { table: focusTable }),
    onSuccess: (r) => setResult(r),
  })

  // No rail without a connection, or when AI mode is disabled server-side.
  if (!connectionId || (config.data && !config.data.available)) return null

  // Collapsed: a slim strip with a button to reopen.
  if (collapsed) {
    return (
      <aside className="flex h-screen w-9 shrink-0 flex-col items-center border-l border-border bg-card py-3">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title="Show AI panel"
          onClick={() => setCollapsed(false)}
        >
          <Sparkles className="h-4 w-4" />
        </Button>
      </aside>
    )
  }

  const configured = config.data?.configured ?? false

  const openInEditor = (sql: string) => {
    setSeed(sql)
    openTab({ kind: 'query' })
    navigate({ to: '/query' })
  }

  const submit = () => {
    if (!prompt.trim() || generate.isPending) return
    setResult(null)
    generate.mutate()
  }

  return (
    <aside className="flex h-screen w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-card">
      <section className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Sparkles className="h-3 w-3" /> Ask AI
          <span className="rounded bg-amber-500/15 px-1 py-px text-[9px] font-semibold normal-case tracking-normal text-amber-600 dark:text-amber-500">
            Beta
          </span>
        </h3>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            title="AI settings"
            onClick={() => setShowSettings((v) => !v)}
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            title="Hide AI panel"
            onClick={() => setCollapsed(true)}
          >
            <PanelRightClose className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {showSettings && config.data && (
        <AiSettings
          config={config.data}
          onSaved={() => qc.invalidateQueries({ queryKey: ['ai-config'] })}
        />
      )}

      {!configured ? (
        <p className="text-xs text-muted-foreground">
          {config.data?.provider === 'openai'
            ? 'Add an OpenAI API key in settings to ask questions in plain English.'
            : 'Add an Anthropic API key in settings to ask questions in plain English.'}
        </p>
      ) : (
        <>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
            }}
            rows={2}
            placeholder="orders from last week that weren't shipped…"
            className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button
            size="sm"
            className="mt-2 w-full"
            disabled={!prompt.trim() || generate.isPending}
            onClick={submit}
          >
            {generate.isPending ? (
              <Spinner aria-label="Generating" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {generate.isPending ? 'Generating…' : 'Generate SQL'}
          </Button>

          {generate.error && (
            <p className="mt-2 text-xs text-destructive">
              {(generate.error as Error).message}
              {(generate.error as { hint?: string }).hint && (
                <span className="block text-muted-foreground">
                  {(generate.error as { hint?: string }).hint}
                </span>
              )}
            </p>
          )}

          {result && (
            <div className="mt-3 space-y-2">
              {result.refusal ? (
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  {result.refusal}
                </p>
              ) : (
                <>
              {result.explanation && (
                <p className="text-xs text-muted-foreground">{result.explanation}</p>
              )}
              {(result.usage.inputTokens != null || result.usage.outputTokens != null) && (
                <p className="text-[11px] text-muted-foreground">
                  {result.usage.inputTokens?.toLocaleString() ?? '—'} in ·{' '}
                  {result.usage.outputTokens?.toLocaleString() ?? '—'} out tokens
                </p>
              )}
              <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/50 p-2 text-[11px] leading-snug">
                {result.sql}
              </pre>
              {!result.readOnly && (
                <p className="text-[11px] text-amber-600 dark:text-amber-500">
                  ⚠ This query writes data — review carefully before running.
                </p>
              )}
              {result.validationError && (
                <p className="text-[11px] text-amber-600 dark:text-amber-500">
                  ⚠ Postgres rejected this query: {result.validationError}. Review and fix
                  before running.
                </p>
              )}
              {result.rowCount != null && result.rowCount > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Matches ~{result.rowCount.toLocaleString()} rows right now.
                </p>
              )}
              {result.rowCount === 0 && (
                <p className="text-[11px] text-amber-600 dark:text-amber-500">
                  ⚠ This query is valid but matches 0 rows right now — a filter or join
                  may not fit your data. Edit it in the editor before trusting the result.
                </p>
              )}
              <div className="flex gap-2">
                <Button size="sm" className="flex-1" onClick={() => openInEditor(result.sql)}>
                  Open in editor <ArrowRight className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="outline"
                  title="Copy SQL"
                  onClick={() => copyText(result.sql)}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
                </>
              )}
            </div>
          )}
        </>
      )}
      </section>
    </aside>
  )
}

// "Small" unless the model tag names a ≥20b parameter count ('llama3.1:70b').
// Untagged names ('llama3.1') pull the small variant by default ⇒ warn.
function smallLocalModel(model: string) {
  const m = model.match(/(\d+(?:\.\d+)?)b/i)
  return !m || parseFloat(m[1]) < 20
}

const PROVIDER_LABELS: Record<AiConfig['provider'], string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  ollama: 'Ollama (local)',
}
const KEY_PLACEHOLDER: Record<AiConfig['provider'], string> = {
  anthropic: 'sk-ant-…',
  openai: 'sk-…',
  ollama: '',
}

function AiSettings({ config, onSaved }: { config: AiConfig; onSaved: () => void }) {
  const { provider, model, ollamaHost, allowWrites, configured } = config
  const [key, setKey] = useState('')
  const [modelDraft, setModelDraft] = useState(model)
  const [hostDraft, setHostDraft] = useState(ollamaHost)

  // Keep local drafts in sync when a save round-trips a new server value (e.g.
  // switching provider resets the model to that provider's default).
  useEffect(() => setModelDraft(model), [model])
  useEffect(() => setHostDraft(ollamaHost), [ollamaHost])

  const save = useMutation({
    mutationFn: (payload: AiConfigPayload) => setAiConfig(payload),
    onSuccess: onSaved,
  })

  return (
    <div className="mb-3 space-y-2 rounded-md border border-border bg-muted/30 p-2">
      <label className="block text-[11px] text-muted-foreground">
        Provider
        <Select
          value={provider}
          onChange={(e) => save.mutate({ provider: e.target.value as AiConfig['provider'] })}
          className="mt-1 h-8 text-xs"
        >
          {(Object.keys(PROVIDER_LABELS) as AiConfig['provider'][]).map((p) => (
            <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
          ))}
        </Select>
      </label>

      <div className="flex gap-2">
        <Input
          value={modelDraft}
          onChange={(e) => setModelDraft(e.target.value)}
          placeholder="model"
          className="h-8 flex-1 text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!modelDraft.trim() || modelDraft === model || save.isPending}
          onClick={() => save.mutate({ model: modelDraft.trim() })}
        >
          Set model
        </Button>
      </div>

      {provider === 'ollama' ? (
        <>
          <div className="flex gap-2">
            <Input
              value={hostDraft}
              onChange={(e) => setHostDraft(e.target.value)}
              placeholder="http://127.0.0.1:11434"
              className="h-8 flex-1 text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!hostDraft.trim() || hostDraft === ollamaHost || save.isPending}
              onClick={() => save.mutate({ ollamaHost: hostDraft.trim() })}
            >
              Set host
            </Button>
          </div>
          {smallLocalModel(model) && (
            <p className="text-[11px] text-amber-600 dark:text-amber-500">
              8b-class local models produce significantly less accurate SQL — for
              reliable results use a larger model (70b+) or a cloud provider.
            </p>
          )}
        </>
      ) : (
        <>
          <div className="flex gap-2">
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={configured ? 'Replace API key…' : KEY_PLACEHOLDER[provider]}
              className="h-8 flex-1 text-xs"
            />
            <Button
              size="sm"
              disabled={!key.trim() || save.isPending}
              onClick={() => save.mutate({ apiKey: key.trim() }, { onSuccess: () => setKey('') })}
            >
              Save key
            </Button>
          </div>
          {configured && (
            <button
              className="text-[11px] text-muted-foreground hover:text-destructive"
              onClick={() => save.mutate({ apiKey: null })}
            >
              Remove stored key
            </button>
          )}
        </>
      )}

      <label className={cn('flex items-center gap-2 text-xs', !configured && 'opacity-50')}>
        <input
          type="checkbox"
          checked={allowWrites}
          disabled={!configured}
          onChange={(e) => save.mutate({ allowWrites: e.target.checked })}
        />
        Allow write queries (INSERT/UPDATE/DELETE)
      </label>
      {save.error && (
        <p className="text-[11px] text-destructive">{(save.error as Error).message}</p>
      )}
    </div>
  )
}
