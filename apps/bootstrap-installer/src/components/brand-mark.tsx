import forxMark from '../../../../assets/forx-mark.svg'

import { cn } from '../lib/utils'

export function BrandMark({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span className={cn('inline-flex size-14 shrink-0 items-center justify-center', className)} {...props}>
      <img alt="" className="size-full object-contain" src={forxMark} />
    </span>
  )
}
