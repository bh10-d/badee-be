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

    const cc1Packet = JSON.stringify({
      Data: {
        Name: 'Centauri Carbon',
        MachineName: 'Centauri Carbon',
        MainboardIP: '192.168.10.110',
        MainboardID: '045715940107202800007c0000000000',
        FirmwareVersion: 'V1.6.49',
      },
    });
    expect(parseElegooSdcpPacket(cc1Packet, '192.168.10.110')?.model).toBe('cc1');
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

    // Real Kobra 3 / S1 / Kobra X LAN Mode :18910/info JSON shape
    const realLanInfo = parseAnycubicInfoResponse(
      {
        ctrlType: 'lan',
        token: 'tok123',
        ctrlInfoUrl: 'http://192.168.10.207:18910/ctrl',
        modelId: 20025,
        cn: 'SERIAL123',
        usn: 'uuid:fdm:20025',
      },
      '192.168.10.207',
    );
    expect(realLanInfo).toEqual({
      ip: '192.168.10.207',
      brand: 'anycubic',
      model: 'kobra-x',
      name: 'Anycubic Kobra (20025)',
      serialNumber: 'SERIAL123',
      firmware: null,
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
