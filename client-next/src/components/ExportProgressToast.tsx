import { Database, Loader2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

interface Props {
  bytes: number
  currentTable?: string
  onCancel?: () => void
}

export function ExportProgressToast({ bytes, currentTable, onCancel }: Props) {
  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 rounded-lg border border-border bg-card p-3 shadow-lg">
      <div className="flex items-start gap-2">
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Exporting backup…</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {formatBytes(bytes)} written
            {currentTable && (
              <>
                {' · '}
                <Database className="inline h-3 w-3" /> {currentTable}
              </>
            )}
          </p>
        </div>
        {onCancel && (
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={onCancel}
            aria-label="Cancel export"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
        {/* Indeterminate bar — server doesn't report total size. */}
        <div className="h-full w-1/3 animate-[pulse_1.4s_ease-in-out_infinite] rounded-full bg-primary/60" />
      </div>
    </div>
  )
}
