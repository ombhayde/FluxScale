import type { ComponentType, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };
export type FluxIcon = ComponentType<IconProps>;

// Shared open corners and a 24-unit construction give the console its own symbols.
function symbol(path: string): FluxIcon {
  return function FluxSymbol({ size = 24, ...props }: IconProps) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true" focusable="false" {...props}><path d={path} /></svg>;
  };
}

export const Activity = symbol('M3 17h4V9h5v5h5V5h4');
export const ArrowDownRight = symbol('M5 5l14 14M9 19h10V9');
export const ArrowUpRight = symbol('M5 19 19 5M9 5h10v10');
export const Boxes = symbol('M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z');
export const BrainCircuit = symbol('M4 4h6v6H4zM14 14h6v6h-6zM10 7h7v7M7 10v7h7M17 4v3M4 17h3');
export const Clock3 = symbol('M20 12a8 8 0 1 1-8-8M12 7v5l4 2M17 4h3v3');
export const Cpu = symbol('M6 6h12v12H6zM10 10h4v4h-4zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4');
export const Database = symbol('M4 5l8-3 8 3v14l-8 3-8-3zM4 5l8 3 8-3M4 12l8 3 8-3M12 8v14');
export const Gauge = symbol('M3 19V9l9-6 9 6v10M7 18h10M12 14l4-6');
export const Eye = symbol('M2 12l5-6h10l5 6-5 6H7zM9 9h6v6H9z');
export const EyeOff = symbol('M3 3l18 18M3 12l4-6h8M21 12l-4 6H9');
export const Search = symbol('M4 4h10v10H4zM14 14l7 7');
export const KeyRound = symbol('M3 3h8v8H3zM11 11l10 10M15 15l3-3M18 18l3-3');
export const LogOut = symbol('M9 3H3v18h6M10 12h11M17 8l4 4-4 4');
export const MemoryStick = symbol('M3 6h18v11H3zM7 10v3M12 10v3M17 10v3M6 17v4M10 17v4M14 17v4M18 17v4');
export const Radio = symbol('M3 3h6v6H3zM15 3h6v6h-6zM9 15h6v6H9zM6 9v3h12V9M12 12v3');
export const RefreshCw = symbol('M4 10V4h6M4 4l4 4M20 14v6h-6M20 20l-4-4M8 8a6 6 0 0 1 11 2M16 16A6 6 0 0 1 5 14');
export const Server = symbol('M3 3h18v7H3zM3 14h18v7H3zM7 6.5h3M7 17.5h3M17 6v1M17 17v1');
export const ShieldCheck = symbol('M4 4l8-2 8 2v10l-8 8-8-8zM8 11l3 3 6-7');
export const TriangleAlert = symbol('M12 3 2 21h20zM12 9v5M12 17v1');
export const Trash2 = symbol('M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7M14 10v7');
export const Zap = symbol('M14 2 4 13h7l-1 9 10-12h-7z');
