import { ClassSet } from '../schema/classes.ts';

/**
 * PROVISIONAL vehicle classes, used until the data pipeline produces classes.json from the
 * Chennai trajectories. Every value is an engineering assumption (typical literature ranges
 * for Indian mixed traffic), labelled as such.
 */
const NOTE = 'provisional engineering default; replaced by Chennai calibration';
const a = (value: number, spread = 0) => ({ value, provenance: 'assumption' as const, note: NOTE, spread });
const fixed = (value: number) => ({ kind: 'fixed' as const, value, provenance: 'assumption' as const, note: NOTE });
const q = (...values: number[]) => ({ kind: 'quantiles' as const, q: values, provenance: 'assumption' as const, note: NOTE });

export function defaultClasses(): ClassSet {
  return ClassSet.parse({
    version: 1,
    source: 'provisional defaults (assumptions), pending Chennai calibration',
    classes: [
      {
        id: 'motorcycle', label: 'Motorcycle', lengthM: fixed(1.9), widthM: fixed(0.7),
        idm: { v0: a(16.7, 0.1), T: a(0.8, 0.1), s0: a(1.0), a: a(2.0), b: a(3.0) },
        clearance: { c0: a(0.2), c1: a(0) }, gap: { criticalS: a(3.0), followUpS: a(1.8) },
        lateral: { maxSpeedMps: a(1.0), politeness: a(0.1), thresholdMps2: a(0.1) }, share: a(0.5),
      },
      {
        id: 'car', label: 'Car', lengthM: q(3.6, 3.9, 4.2, 4.5, 4.8), widthM: q(1.55, 1.7, 1.85),
        idm: { v0: a(15.3, 0.1), T: a(1.2, 0.1), s0: a(2.0), a: a(1.5), b: a(2.5) },
        clearance: { c0: a(0.3), c1: a(0) }, gap: { criticalS: a(4.0), followUpS: a(2.5) },
        lateral: { maxSpeedMps: a(0.6), politeness: a(0.2), thresholdMps2: a(0.1) }, share: a(0.3),
      },
      {
        id: 'auto', label: 'Auto-rickshaw', lengthM: fixed(2.6), widthM: fixed(1.3),
        idm: { v0: a(12.5, 0.1), T: a(1.0, 0.1), s0: a(1.5), a: a(1.2), b: a(2.5) },
        clearance: { c0: a(0.25), c1: a(0) }, gap: { criticalS: a(3.5), followUpS: a(2.2) },
        lateral: { maxSpeedMps: a(0.7), politeness: a(0.1), thresholdMps2: a(0.1) }, share: a(0.1),
      },
      {
        id: 'bus', label: 'Bus', lengthM: q(9.5, 10.3, 12), widthM: fixed(2.5),
        idm: { v0: a(13.9, 0.1), T: a(1.6, 0.1), s0: a(2.5), a: a(0.9), b: a(2.0) },
        clearance: { c0: a(0.4), c1: a(0) }, gap: { criticalS: a(5.0), followUpS: a(3.2) },
        lateral: { maxSpeedMps: a(0.4), politeness: a(0.3), thresholdMps2: a(0.2) }, share: a(0.04),
      },
      {
        id: 'truck', label: 'Truck', lengthM: q(6.0, 7.5, 9.0), widthM: fixed(2.4),
        idm: { v0: a(12.5, 0.1), T: a(1.8, 0.1), s0: a(2.5), a: a(0.7), b: a(2.0) },
        clearance: { c0: a(0.4), c1: a(0) }, gap: { criticalS: a(5.5), followUpS: a(3.5) },
        lateral: { maxSpeedMps: a(0.4), politeness: a(0.3), thresholdMps2: a(0.2) }, share: a(0.02),
      },
      {
        id: 'lcv', label: 'LCV', lengthM: q(4.5, 5.0, 5.6), widthM: fixed(1.9),
        idm: { v0: a(13.9, 0.1), T: a(1.4, 0.1), s0: a(2.0), a: a(1.1), b: a(2.2) },
        clearance: { c0: a(0.35), c1: a(0) }, gap: { criticalS: a(4.5), followUpS: a(2.8) },
        lateral: { maxSpeedMps: a(0.5), politeness: a(0.2), thresholdMps2: a(0.15) }, share: a(0.04),
      },
    ],
  });
}
