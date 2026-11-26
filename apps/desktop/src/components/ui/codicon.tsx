import type { Icon } from '@tabler/icons-react'
import type * as React from 'react'

import { cn } from '@/lib/utils'

export interface CodiconProps extends React.HTMLAttributes<HTMLElement> {
  name: string
  size?: number | string
  spinning?: boolean
}

export function Codicon({ className, name, size, spinning, style, ...props }: CodiconProps) {
  return (
    <i
      aria-hidden="true"
      className={cn('codicon', `codicon-${name}`, spinning && 'codicon-modifier-spin', className)}
      style={{ ...(size != null && size !== '' ? { fontSize: size } : {}), ...style }}
      {...props}
    />
  )
}

/** Wrap a codicon as a Tabler-shaped icon for nav rows that expect `IconComponent`. */
export function codiconIcon(name: string): Icon {
  function CodiconIcon({ className, size = '1em' }: Pick<CodiconProps, 'className' | 'size'>) {
    return <Codicon aria-hidden className={cn('leading-none', className)} name={name} size={size} />
  }

  CodiconIcon.displayName = `Codicon(${name})`

  return CodiconIcon as Icon
}
