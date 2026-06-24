import { useState } from 'react'
import { Copy as CopyIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'

/** Copy-to-clipboard button that flips to "Copied" for 1.5s on success. */
export function CopyButton({
  text, label = 'Copy', className,
}: {
  text: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    void copyText(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <Button size="sm" variant="ghost" className={cn('h-7', className)} onClick={onCopy}>
      <CopyIcon className="h-3.5 w-3.5" />
      {copied ? 'Copied' : label}
    </Button>
  )
}
