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
