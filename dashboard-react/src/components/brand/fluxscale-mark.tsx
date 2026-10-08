import { cn } from "@/lib/utils";

interface FluxScaleMarkProps {
  className?: string;
  title?: string;
}

export function FluxScaleMark({
  className,
  title = "FluxScale",
}: FluxScaleMarkProps) {
  return (
    <svg
      viewBox="0 0 48 48"
      role="img"
      aria-label={title}
      className={cn("size-10", className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="fluxscale-mark-gradient" x1="8" y1="40" x2="41" y2="8">
          <stop stopColor="#4f46e5" />
          <stop offset="0.52" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
      </defs>

      <rect x="2" y="2" width="44" height="44" rx="14" fill="url(#fluxscale-mark-gradient)" />
      <path
        d="M10 31.5h6.2l3.8-14 5.2 21 4.3-16 2.7 9H38"
        stroke="white"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="38" cy="31.5" r="2.2" fill="#a7f3d0" />
    </svg>
  );
}
