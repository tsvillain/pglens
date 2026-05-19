import * as React from 'react'
import { ChevronDown } from 'lucide-react'

import { cn } from '@/lib/utils'

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>

/**
 * Styled native <select>. Native chevron is suppressed via appearance-none
 * and replaced with a Lucide icon so it matches the rest of the UI in both
 * light and dark themes.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => (
    <div className={cn('relative inline-flex h-8 w-full items-center', className)}>
      <select
        ref={ref}
        className="peer absolute inset-0 h-full w-full appearance-none rounded-md border border-input bg-background px-2 pr-8 text-sm leading-none shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-muted-foreground" />
    </div>
  ),
)
Select.displayName = 'Select'
