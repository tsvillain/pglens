import { useEffect, useState } from 'react'

import { SqlConsole } from '@/components/SqlConsole'
import { useConnectionStore } from '@/store/connection'
import { useQuerySeedStore } from '@/store/querySeed'

const DEFAULT_SQL = `-- Advanced mode. Raw SQL escape hatch.
-- Press Cmd/Ctrl + Enter to run.

SELECT now();`

export function QueryRunner() {
  const connectionId = useConnectionStore((s) => s.activeConnectionId)
  const [sql, setSql] = useState(DEFAULT_SQL)

  // Apply a one-shot seed handed in from elsewhere (e.g. the slow-query
  // drilldown's "Explain" action), then clear it so it doesn't reapply. Works
  // whether this tab was just opened or was already mounted.
  const seed = useQuerySeedStore((s) => s.seed)
  const clearSeed = useQuerySeedStore((s) => s.clear)
  useEffect(() => {
    if (seed != null) {
      setSql(seed)
      clearSeed()
    }
  }, [seed, clearSeed])

  if (!connectionId) {
    return (
      <div className="px-10 py-10 text-sm text-muted-foreground">
        No active connection.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-6 py-3">
        <h1 className="text-lg font-semibold">Query</h1>
        <p className="text-xs text-muted-foreground">Advanced mode (raw SQL)</p>
      </header>
      <div className="min-h-0 flex-1">
        <SqlConsole
          connectionId={connectionId}
          tabId="query"
          value={sql}
          onChange={setSql}
        />
      </div>
    </div>
  )
}
