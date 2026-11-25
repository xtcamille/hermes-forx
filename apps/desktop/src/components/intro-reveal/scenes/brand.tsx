import type { ComponentProps } from 'react'

import { BrandMark } from '@/components/brand-mark'

interface BrandCloseProps extends ComponentProps<'div'> {}

export function BrandClose({ ref }: BrandCloseProps) {
  return (
    <div
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-[3.2vmin] opacity-0"
      ref={ref}
      style={{ willChange: 'transform, opacity' }}
    >
      <BrandMark className="size-[28vmin]" />
      <div className="flex flex-col items-center gap-[1.6vmin]">
        <h1
          className="text-[9.5vmin] leading-none font-bold tracking-tight text-(color:--intro-title)"
          style={{ fontFamily: "'Collapse', sans-serif" }}
        >
          ForX Agent
        </h1>
        <p
          className="text-[2.2vmin] tracking-[0.24em] text-(color:--intro-caption) uppercase"
          style={{ fontFamily: "'Collapse', sans-serif" }}
        >
          Your agent, everywhere
        </p>
      </div>
    </div>
  )
}
