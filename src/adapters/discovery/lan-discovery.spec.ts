import { describe, expect, it } from 'vitest';
import {
  normalizePrivateSubnet,
  parseAnycubicInfoResponse,
  parseElegooSdcpPacket,
} from './lan-discovery.service';

describe('LanDiscoveryService parsers & SSRF guards', () => {
  it('parses Elegoo SDCP M99999 UDP response into unified printer metadata', () => {
    const packet = JSON.stringify({
      Id: 'abc',
      Data: {
        Name: 'Centauri Carbon 2',
        MachineName: 'Centauri Carbon 2',
        MainboardIP: '192.168.1.42',
        MainboardID: 'ELG-CC2-9988',
        FirmwareVersion: 'V1.2.8',
      },
    });

    const parsed = parseElegooSdcpPacket(packet, '192.168.1.42');
    expect(parsed).toEqual({
      ip: '192.168.1.42',
      brand: 'elegoo',
      model: 'cc2',
      name: 'Centauri Carbon 2',
      serialNumber: 'ELG-CC2-9988',
      firmware: 'V1.2.8',
      protocol: 'sdcp-udp',
    });
  });

  it('parses Anycubic LAN HTTP :18910/info response into unified printer metadata', () => {
    const parsed = parseAnycubicInfoResponse(
      {
        data: {
          model: 'Kobra X (K4Pro)',
          name: 'Workshop Kobra X',
          cn: 'AC-KX-5511',
          firmware_version: '2.3.5',
        },
      },
      '192.168.1.88',
    );

    expect(parsed).toEqual({
      ip: '192.168.1.88',
      brand: 'anycubic',
      model: 'kobra-x',
      name: 'Workshop Kobra X',
      serialNumber: 'AC-KX-5511',
      firmware: '2.3.5',
      protocol: 'anycubic-lan-http',
    });
  });

  it('enforces RFC1918 private LAN subnets and rejects SSRF / public ranges', () => {
    expect(normalizePrivateSubnet('192.168.1.0/24')).toBe('192.168.1');
    expect(normalizePrivateSubnet('10.0.5')).toBe('10.0.5');
    expect(normalizePrivateSubnet('172.16.20.0/24')).toBe('172.16.20');

    expect(normalizePrivateSubnet('8.8.8.0/24')).toBeNull();
    expect(normalizePrivateSubnet('169.254.169.0/24')).toBeNull();
    expect(normalizePrivateSubnet('127.0.0.0/24')).toBeNull();
    expect(normalizePrivateSubnet('invalid-subnet')).toBeNull();
  });
});
