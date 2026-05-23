import { useEffect, useMemo, useState } from 'react'
import { Spinner as UnicodeSpinner, type SpinnerName } from 'unicode-spinner'
import { cn } from '@/lib/utils'

interface SpinnerProps {
  /** Built-in frame sequence. Defaults to braille (the Claude-style sweep). */
  variant?: SpinnerName
  /** Override ms per frame; falls back to the sequence's recommended interval. */
  interval?: number
  className?: string
  'aria-label'?: string
}

/**
 * Animated text spinner backed by unicode-spinner's subscribe mode — renders
 * the current frame glyph and advances it via the package's internal timer.
 * Drop-in replacement for a CSS-animated icon spinner.
 */
export function Spinner({
  variant = 'braille',
  interval,
  className,
  'aria-label': ariaLabel = 'Loading',
}: SpinnerProps) {
  const spinner = useMemo(
    () => new UnicodeSpinner({ frames: variant, ...(interval ? { interval } : {}) }),
    [variant, interval],
  )
  const [frame, setFrame] = useState(spinner.currentFrame)

  useEffect(() => {
    const unsubscribe = spinner.subscribe(setFrame)
    spinner.startFrames()
    return () => {
      spinner.stopFrames()
      unsubscribe()
    }
  }, [spinner])

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={cn('inline-block tabular-nums leading-none', className)}
    >
      {frame}
    </span>
  )
}

/**
 * Spinner + label, laid out inline. Use for "Loading…"-style status text so
 * every loader shares the same animated glyph and spacing.
 */
export function Loading({
  children,
  variant,
  className,
}: {
  children: React.ReactNode
  variant?: SpinnerName
  className?: string
}) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <Spinner variant={variant} aria-label="Loading" />
      <span>{children}</span>
    </span>
  )
}
