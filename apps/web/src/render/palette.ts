import type { VehicleClassId } from '@weave/engine';

/** Vehicle class colours: distinct hues, legible on both the dark and light road surfaces. */
export const CLASS_COLORS: Record<VehicleClassId, { dark: string; light: string; label: string }> = {
  motorcycle: { dark: '#f5a524', light: '#c2700a', label: 'Motorcycle' },
  car: { dark: '#38bdf8', light: '#0369a1', label: 'Car' },
  auto: { dark: '#a3e635', light: '#4d7c0f', label: 'Auto-rickshaw' },
  bus: { dark: '#c084fc', light: '#7e22ce', label: 'Bus' },
  truck: { dark: '#fb7185', light: '#be123c', label: 'Truck' },
  lcv: { dark: '#2dd4bf', light: '#0f766e', label: 'LCV' },
};

export interface MapTheme {
  ground: string;
  road: string;
  roadEdge: string;
  flyover: string;
  marking: string;
  shadow: string;
  dark: boolean;
}

export function readMapTheme(): MapTheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const dark = !window.matchMedia('(prefers-color-scheme: light)').matches;
  return {
    ground: v('--color-ground', '#0d141c'),
    road: v('--color-road', '#2a3644'),
    roadEdge: v('--color-road-edge', '#3b4a5c'),
    flyover: v('--color-flyover', '#3a4858'),
    marking: dark ? 'rgba(230,237,243,0.28)' : 'rgba(255,255,255,0.9)',
    shadow: dark ? 'rgba(0,0,0,0.55)' : 'rgba(15,23,32,0.25)',
    dark,
  };
}

export type ColourMode = 'class' | 'speed';

/** Speed ramp stops (§6.3 item 2): stopped → half → free flow. */
export const SPEED_STOPS: [number, string][] = [
  [0, '#dc2626'],
  [0.5, '#f59e0b'],
  [1, '#16a34a'],
];

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];

/** Colour for a speed ratio in [0, 1] (v / free-flow speed), as an RGB triple 0–255. */
export function speedRgb(r: number): [number, number, number] {
  const x = r < 0 ? 0 : r > 1 ? 1 : r;
  const [a, b] = x <= 0.5 ? [SPEED_STOPS[0]!, SPEED_STOPS[1]!] : [SPEED_STOPS[1]!, SPEED_STOPS[2]!];
  const u = (x - a[0]) / (b[0] - a[0]);
  const ca = hex(a[1]);
  const cb = hex(b[1]);
  return [0, 1, 2].map((i) => Math.round(ca[i]! + (cb[i]! - ca[i]!) * u)) as [number, number, number];
}

export const speedCss = (r: number) => `rgb(${speedRgb(r).join(',')})`;

/** CSS gradient for the speed legend. */
export const SPEED_GRADIENT = `linear-gradient(to right, ${SPEED_STOPS.map(([p, c]) => `${c} ${p * 100}%`).join(', ')})`;

/** Class colour for the current theme. */
export function classCss(id: VehicleClassId | undefined, dark: boolean): string {
  const c = id ? CLASS_COLORS[id] : undefined;
  return c ? (dark ? c.dark : c.light) : '#e6edf3';
}
