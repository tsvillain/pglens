import { Monitor, Moon, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useThemeStore, type Theme } from '@/store/theme'

const OPTIONS: { value: Theme; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'dark', icon: Moon, label: 'Dark' },
  { value: 'system', icon: Monitor, label: 'System' },
]

export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)
  return (
    <div className="inline-flex rounded-md border border-border bg-muted p-0.5">
      {OPTIONS.map((o) => {
        const Icon = o.icon
        return (
          <Button
            key={o.value}
            size="icon"
            variant="ghost"
            title={o.label}
            onClick={() => setTheme(o.value)}
            className={cn(
              'h-6 w-6 rounded-sm',
              theme === o.value && 'bg-card text-foreground shadow-sm',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </Button>
        )
      })}
    </div>
  )
}
