import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

interface DropdownProps {
  trigger: (props: { open: boolean }) => React.ReactNode
  children: React.ReactNode
  align?: 'start' | 'end'
  className?: string
}

/**
 * Tiny click-to-open menu. Closes on outside click + Escape. Children are
 * rendered inside a wrapper that closes the menu when any descendant
 * `<button>` is clicked.
 */
export function Dropdown({ trigger, children, align = 'end', className }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button type="button" onClick={() => setOpen((v) => !v)} className="contents">
        {trigger({ open })}
      </button>
      {open && (
        <div
          className={cn(
            'absolute top-full z-20 mt-1 w-56 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md',
            align === 'end' ? 'right-0' : 'left-0',
            className,
          )}
          onClick={(e) => {
            // Close after a menu item's click handler runs.
            if ((e.target as HTMLElement).closest('button')) {
              setTimeout(() => setOpen(false), 0)
            }
          }}
        >
          {children}
        </div>
      )}
    </div>
  )
}

export function DropdownItem({
  icon: Icon, children, onClick, disabled,
}: {
  icon?: React.ComponentType<{ className?: string }>
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />}
      <span className="truncate">{children}</span>
    </button>
  )
}
