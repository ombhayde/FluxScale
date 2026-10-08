import { cn } from '@/lib/utils';

export function FluxScaleMark({ className, title = 'FluxScale' }: { className?: string; title?: string }) {
  return <svg viewBox="0 0 48 48" role="img" aria-label={title} className={cn('size-10', className)} xmlns="http://www.w3.org/2000/svg">
    <rect width="48" height="48" rx="10" fill="#173d32" />
    <path d="M10 34V25h7v9zm10 0V17h7v17zm10 0V9h7v25z" fill="#d3ef8d" />
    <path d="M10 20 37 5" fill="none" stroke="#d3ef8d" strokeWidth="2" />
  </svg>;
}
