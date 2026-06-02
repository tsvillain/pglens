import { Table as TableIcon, Terminal } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { TabMode } from '@/store/tabMode'

const OPTIONS: Array<{ value: TabMode; label: string; Icon: typeof TableIcon }> = [
  { value: 'nocode', label: 'No-code', Icon: TableIcon },
  { value: 'advanced', label: 'Advanced', Icon: Terminal },
]

/**
 * `[ No-code | Advanced ]` segmented switch shown in a table tab's header
 * (roadmap §5.1). Per-tab, so a no-code view and a hand-written query can be
 * held open side by side.
 */
export function ModeToggle({
  mode,
  onChange,
}: {
  mode: TabMode
  onChange: (mode: TabMode) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Tab mode"
      className="inline-flex rounded-md border border-border bg-muted/40 p-0.5 text-xs"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = mode === value
        return (
          <button
            key={value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(value)}
            className={cn(
              'flex items-center gap-1.5 rounded px-2.5 py-1 transition',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        )
      })}
    </div>
  )
}
