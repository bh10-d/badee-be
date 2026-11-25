import { Injectable, Logger } from '@nestjs/common';
import { getEnv } from '../config/env';

/**
 * Integrates with MediaMTX Control API (default :6997) to ingest heterogeneous
 * printer camera streams (Elegoo CC2 MJPEG, Anycubic Kobra X HTTP-FLV) and expose
 * uniform low-latency WebRTC / HLS playback URLs.
 */
@Injectable()
export class MediaMtxService {
  private readonly logger = new Logger(MediaMtxService.name);

  getPlaybackUrls(printerId: string): { webrtcUrl: string | null; hlsUrl: string | null } {
    const env = getEnv();
    const safeId = encodeURIComponent(`printer_${printerId}`);
    const webrtcBase = env.MEDIAMTX_WEBRTC_URL?.replace(/\/$/, '');
    if (!webrtcBase) return { webrtcUrl: null, hlsUrl: null };
    return {
      webrtcUrl: `${webrtcBase}/${safeId}`,
      hlsUrl: null,
    };
  }

  async registerPath(printerId: string, sourceUrl: string): Promise<boolean> {
    const apiBase = getEnv().MEDIAMTX_API_URL?.replace(/\/$/, '');
    if (!apiBase || !sourceUrl) return false;

    const pathName = encodeURIComponent(`printer_${printerId}`);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${apiBase}/v3/config/paths/add/${pathName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: sourceUrl,
          sourceOnDemand: true,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.ok || res.status === 409;
    } catch (err) {
      this.logger.warn(`MediaMTX path registration skipped for ${printerId}: ${(err as Error).message}`);
      return false;
    }
  }
}
