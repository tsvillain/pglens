import { useState } from 'react'

import { SqlConsole } from '@/components/SqlConsole'
import { useConnectionStore } from '@/store/connection'

const DEFAULT_SQL = `-- Advanced mode. Raw SQL escape hatch.
-- Press Cmd/Ctrl + Enter to run.

SELECT now();`

export function QueryRunner() {
  const connectionId = useConnectionStore((s) => s.activeConnectionId)
  const [sql, setSql] = useState(DEFAULT_SQL)

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
        <SqlConsole connectionId={connectionId} value={sql} onChange={setSql} />
      </div>
    </div>
  )
}
