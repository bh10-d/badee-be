import { describe, expect, it } from 'vitest';
import { GcodeValidatorService } from './gcode-validator.service';

describe('GcodeValidatorService', () => {
  const validator = new GcodeValidatorService();
  const baseLimits = {
    maxNozzleTemp: 250,
    maxBedTemp: 90,
    buildVolume: { x: 256, y: 256, z: 256 },
    remainingRentalSec: 7200, // 2h remaining
  };

  it('passes a safe sliced G-code file and extracts OrcaSlicer metadata', () => {
    const safeGcode = [
      '; estimated printing time (normal mode) = 1h 15m 30s',
      '; filament used [g] = 42.6',
      'G90',
      'M104 S215',
      'M140 S60',
      'G1 X10 Y10 Z0.2 E1.5',
      'G1 X120 Y120 Z0.2 E12.0',
    ].join('\n');

    const res = validator.validate(safeGcode, baseLimits);
    expect(res.safe).toBe(true);
    expect(res.violations).toHaveLength(0);
    expect(res.metadata.estimatedSec).toBe(4530);
    expect(res.metadata.filamentGrams).toBe(42.6);
  });

  it('blocks dangerous commands, over-temperature, out-of-bounds, and overtime jobs', () => {
    const badGcode = [
      '; estimated printing time (normal mode) = 4h 0m 0s',
      'M500',
      'M303 E0 S220',
      'M109 S290',
      'M190 S110',
      'G1 X310 Y10 Z5',
    ].join('\n');

    const res = validator.validate(badGcode, baseLimits);
    expect(res.safe).toBe(false);
    expect(res.violations.some((v) => v.includes('M500'))).toBe(true);
    expect(res.violations.some((v) => v.includes('M303'))).toBe(true);
    expect(res.violations.some((v) => v.includes('290°C'))).toBe(true);
    expect(res.violations.some((v) => v.includes('110°C'))).toBe(true);
    expect(res.violations.some((v) => v.includes('exceeds build volume'))).toBe(true);
    expect(res.violations.some((v) => v.includes('remaining rental window'))).toBe(true);
  });
});
