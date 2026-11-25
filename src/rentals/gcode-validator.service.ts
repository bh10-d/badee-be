import { Injectable } from '@nestjs/common';

export interface GcodeValidationLimits {
  maxNozzleTemp: number;
  maxBedTemp: number;
  buildVolume: { x: number; y: number; z: number };
  /** Remaining rental duration in seconds (null for admin/operator = unlimited). */
  remainingRentalSec: number | null;
}

export interface GcodeValidationResult {
  safe: boolean;
  violations: string[];
  metadata: {
    estimatedSec: number | null;
    filamentGrams: number | null;
  };
  stats: {
    maxNozzleTemp: number;
    maxBedTemp: number;
    boundsMm: { minX: number; maxX: number; minY: number; maxY: number; maxZ: number };
    lineCount: number;
  };
}

/** Destructive / firmware / calibration commands blocked for untrusted renter G-code. */
const FORBIDDEN_COMMANDS = new Map<string, string>([
  ['M500', 'EEPROM write (M500) is forbidden'],
  ['M502', 'Factory reset (M502) is forbidden'],
  ['M303', 'PID autotune (M303) is forbidden'],
  ['M997', 'Firmware update/reset (M997) is forbidden'],
  ['M112', 'Raw emergency kill (M112) in G-code is forbidden'],
  ['G29', 'Uncontrolled bed-mesh probe (G29) is forbidden for renter jobs'],
]);

function parseDurationToSeconds(raw: string): number | null {
  let total = 0;
  let matched = false;
  const d = /(\d+)\s*d/i.exec(raw);
  const h = /(\d+)\s*h/i.exec(raw);
  const m = /(\d+)\s*m(?!m)/i.exec(raw);
  const s = /(\d+)\s*s/i.exec(raw);
  if (d) {
    total += Number(d[1]) * 86400;
    matched = true;
  }
  if (h) {
    total += Number(h[1]) * 3600;
    matched = true;
  }
  if (m) {
    total += Number(m[1]) * 60;
    matched = true;
  }
  if (s) {
    total += Number(s[1]);
    matched = true;
  }
  return matched ? total : null;
}

/**
 * Fast, streaming-style G-code safety scanner (< 50ms, 0% slicing overhead).
 * Protects physical hardware from malicious or misconfigured renter `.gcode` files.
 */
@Injectable()
export class GcodeValidatorService {
  validate(gcodeText: string, limits: GcodeValidationLimits): GcodeValidationResult {
    const violations: string[] = [];
    const seenViolations = new Set<string>();
    const addViolation = (msg: string) => {
      if (!seenViolations.has(msg)) {
        seenViolations.add(msg);
        violations.push(msg);
      }
    };

    const lines = gcodeText.split(/\r?\n/);
    let maxNozzleTemp = 0;
    let maxBedTemp = 0;
    let estimatedSec: number | null = null;
    let filamentGrams: number | null = null;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let maxZ = 0;
    let absPos = true;
    let curX = 0;
    let curY = 0;
    let curZ = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 1. Parse slicer metadata comments (OrcaSlicer / ElegooSlicer / PrusaSlicer / Anycubic)
      if (line.startsWith(';')) {
        if (estimatedSec === null && /estimated printing time/i.test(line)) {
          const rhs = line.split('=')[1];
          if (rhs) estimatedSec = parseDurationToSeconds(rhs);
        } else if (filamentGrams === null && /filament used \[g\]/i.test(line)) {
          const rhs = line.split('=')[1];
          const val = rhs ? Number.parseFloat(rhs.trim()) : Number.NaN;
          if (Number.isFinite(val) && val > 0) filamentGrams = Math.round(val * 10) / 10;
        }
        continue;
      }

      const codePart = line.split(';')[0].trim();
      if (!codePart) continue;

      const tokens = codePart.split(/\s+/);
      const cmd = tokens[0].toUpperCase();

      // 2. Check forbidden command blacklist
      const forbiddenReason = FORBIDDEN_COMMANDS.get(cmd);
      if (forbiddenReason) {
        addViolation(forbiddenReason);
        continue;
      }

      if (cmd === 'G90') {
        absPos = true;
        continue;
      }
      if (cmd === 'G91') {
        absPos = false;
        continue;
      }

      // 3. Thermal ceiling checks
      if (cmd === 'M104' || cmd === 'M109') {
        const sTok = tokens.find((t) => t.toUpperCase().startsWith('S'));
        const temp = sTok ? Number(sTok.slice(1)) : Number.NaN;
        if (Number.isFinite(temp)) {
          if (temp > maxNozzleTemp) maxNozzleTemp = temp;
          if (temp > limits.maxNozzleTemp) {
            addViolation(
              `Nozzle temperature ${temp}°C exceeds safety limit (${limits.maxNozzleTemp}°C)`,
            );
          }
        }
        continue;
      }

      if (cmd === 'M140' || cmd === 'M190') {
        const sTok = tokens.find((t) => t.toUpperCase().startsWith('S'));
        const temp = sTok ? Number(sTok.slice(1)) : Number.NaN;
        if (Number.isFinite(temp)) {
          if (temp > maxBedTemp) maxBedTemp = temp;
          if (temp > limits.maxBedTemp) {
            addViolation(`Bed temperature ${temp}°C exceeds safety limit (${limits.maxBedTemp}°C)`);
          }
        }
        continue;
      }

      // 4. Build volume bounds check on G0/G1 moves
      if (cmd === 'G0' || cmd === 'G1') {
        let nx = curX;
        let ny = curY;
        let nz = curZ;
        let moved = false;
        for (let t = 1; t < tokens.length; t++) {
          const axis = tokens[t][0]?.toUpperCase();
          const val = Number(tokens[t].slice(1));
          if (!Number.isFinite(val)) continue;
          if (axis === 'X') {
            nx = absPos ? val : curX + val;
            moved = true;
          } else if (axis === 'Y') {
            ny = absPos ? val : curY + val;
            moved = true;
          } else if (axis === 'Z') {
            nz = absPos ? val : curZ + val;
            moved = true;
          }
        }
        if (moved) {
          curX = nx;
          curY = ny;
          curZ = nz;
          if (nx < minX) minX = nx;
          if (nx > maxX) maxX = nx;
          if (ny < minY) minY = ny;
          if (ny > maxY) maxY = ny;
          if (nz > maxZ) maxZ = nz;

          // Allow 2mm margin for purge line; reject anything clearly outside build frame
          if (
            nx < -2 ||
            nx > limits.buildVolume.x + 2 ||
            ny < -2 ||
            ny > limits.buildVolume.y + 2 ||
            nz < -1 ||
            nz > limits.buildVolume.z + 2
          ) {
            addViolation(
              `Toolhead move (${nx.toFixed(1)}, ${ny.toFixed(1)}, ${nz.toFixed(1)}) exceeds build volume (${limits.buildVolume.x}×${limits.buildVolume.y}×${limits.buildVolume.z}mm)`,
            );
          }
        }
      }
    }

    // 5. Rental remaining duration check
    if (
      limits.remainingRentalSec !== null &&
      estimatedSec !== null &&
      estimatedSec > limits.remainingRentalSec
    ) {
      const estMin = Math.ceil(estimatedSec / 60);
      const remMin = Math.floor(limits.remainingRentalSec / 60);
      addViolation(
        `Estimated print duration (${estMin}m) exceeds remaining rental window (${remMin}m)`,
      );
    }

    return {
      safe: violations.length === 0,
      violations,
      metadata: { estimatedSec, filamentGrams },
      stats: {
        maxNozzleTemp,
        maxBedTemp,
        boundsMm: {
          minX: Number.isFinite(minX) ? Math.round(minX * 10) / 10 : 0,
          maxX: Number.isFinite(maxX) ? Math.round(maxX * 10) / 10 : 0,
          minY: Number.isFinite(minY) ? Math.round(minY * 10) / 10 : 0,
          maxY: Number.isFinite(maxY) ? Math.round(maxY * 10) / 10 : 0,
          maxZ: Math.round(maxZ * 10) / 10,
        },
        lineCount: lines.length,
      },
    };
  }
}
