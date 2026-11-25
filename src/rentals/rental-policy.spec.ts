import { describe, expect, it } from 'vitest';
import { evaluateRentalCommandPolicy, type RentalPolicySnapshot } from './rental-policy.service';

const baseSession: RentalPolicySnapshot = {
  status: 'active',
  startsAt: new Date('2026-11-25T00:00:00Z'),
  endsAt: new Date('2026-11-26T00:00:00Z'),
  maxNozzleTemp: 250,
  maxBedTemp: 90,
  allowPauseResume: true,
  allowStop: true,
  allowTempControl: false,
  allowHome: false,
  allowLight: true,
};

const NOW = new Date('2026-11-25T12:00:00Z');

describe('Rental Hardware Safety Policy Filter', () => {
  it('always allows emergency_stop during an active session', () => {
    expect(evaluateRentalCommandPolicy(baseSession, { action: 'emergency_stop' }, NOW)).toEqual({
      allowed: true,
    });
  });

  it('blocks expired or revoked sessions for every command', () => {
    const afterEnd = new Date('2026-11-26T00:01:00Z');
    const res = evaluateRentalCommandPolicy(baseSession, { action: 'pause' }, afterEnd);
    expect(res.allowed).toBe(false);

    const revoked = evaluateRentalCommandPolicy(
      { ...baseSession, status: 'revoked' },
      { action: 'pause' },
      NOW,
    );
    expect(revoked.allowed).toBe(false);
  });

  it('blocks manual homing and temperature override when policy disables them', () => {
    expect(evaluateRentalCommandPolicy(baseSession, { action: 'home' }, NOW).allowed).toBe(false);
    expect(
      evaluateRentalCommandPolicy(baseSession, { action: 'temperature', nozzle: 210 }, NOW).allowed,
    ).toBe(false);
  });

  it('enforces maxNozzleTemp and maxBedTemp caps when temperature control is enabled', () => {
    const withTemp = { ...baseSession, allowTempControl: true };
    expect(
      evaluateRentalCommandPolicy(withTemp, { action: 'temperature', nozzle: 240, bed: 80 }, NOW)
        .allowed,
    ).toBe(true);
    expect(
      evaluateRentalCommandPolicy(withTemp, { action: 'temperature', nozzle: 280 }, NOW).allowed,
    ).toBe(false);
    expect(
      evaluateRentalCommandPolicy(withTemp, { action: 'temperature', bed: 105 }, NOW).allowed,
    ).toBe(false);
  });
});
