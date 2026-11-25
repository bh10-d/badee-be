import { Injectable } from '@nestjs/common';

export interface BatchableOrderItem {
  orderId: string;
  orderCode: string;
  filename: string;
  materialCode: string;
  materialName: string;
  quantity: number;
  priority: 'normal' | 'express';
  estimatedGrams: number;
  /** Optional footprint in mm; if absent, estimated conservatively from estimatedGrams. */
  widthMm?: number;
  depthMm?: number;
}

export interface PlacedItem {
  orderId: string;
  orderCode: string;
  filename: string;
  unitIndex: number;
  xMm: number;
  yMm: number;
  widthMm: number;
  depthMm: number;
  priority: 'normal' | 'express';
}

export interface BatchPlatePlan {
  plateIndex: number;
  materialCode: string;
  materialName: string;
  plateWidthMm: number;
  plateDepthMm: number;
  isolated: boolean;
  reason: string;
  utilizationPercent: number;
  totalGrams: number;
  items: PlacedItem[];
}

export interface BatchPlanOptions {
  plateWidthMm?: number;
  plateDepthMm?: number;
  edgeMarginMm?: number;
  partGapMm?: number;
  maxPartsPerPlate?: number;
  /** Parts exceeding this fraction of usable plate area get their own dedicated plate. */
  largePartAreaRatio?: number;
}

/**
 * Ultra-fast 2D Shelf Bin-Packing planner (< 2ms, 0% heavy server load).
 * Groups small On-Demand orders of the same material onto shared build plates while
 * automatically isolating large parts onto dedicated plates to minimize failure blast radius.
 * Designed for Semi-Auto + Manual Override (operators can inspect, remove items, or dispatch).
 */
@Injectable()
export class PlateBatcherService {
  planBatches(orders: BatchableOrderItem[], opts: BatchPlanOptions = {}): BatchPlatePlan[] {
    const plateW = opts.plateWidthMm ?? 256;
    const plateD = opts.plateDepthMm ?? 256;
    const margin = opts.edgeMarginMm ?? 15;
    const gap = opts.partGapMm ?? 8;
    const maxParts = opts.maxPartsPerPlate ?? 8;
    const largeRatio = opts.largePartAreaRatio ?? 0.45;

    const usableW = Math.max(40, plateW - margin * 2);
    const usableD = Math.max(40, plateD - margin * 2);
    const usableArea = usableW * usableD;

    // Group orders by materialCode so incompatible filaments are never mixed on 1 plate
    const byMaterial = new Map<string, BatchableOrderItem[]>();
    for (const o of orders) {
      const list = byMaterial.get(o.materialCode) ?? [];
      list.push(o);
      byMaterial.set(o.materialCode, list);
    }

    const plates: BatchPlatePlan[] = [];
    let plateCounter = 1;

    for (const [materialCode, group] of byMaterial.entries()) {
      const materialName = group[0].materialName;

      interface ExpandedUnit {
        orderId: string;
        orderCode: string;
        filename: string;
        unitIndex: number;
        w: number;
        d: number;
        grams: number;
        priority: 'normal' | 'express';
      }

      const smallUnits: ExpandedUnit[] = [];
      const largeUnits: ExpandedUnit[] = [];

      for (const order of group) {
        // Conservative square footprint estimate when exact STL bounds are not supplied
        const estSide = Math.max(24, Math.min(usableW, Math.round(Math.cbrt(order.estimatedGrams * 1800))));
        const w = Math.min(usableW, Math.max(15, Math.round(order.widthMm ?? estSide)));
        const d = Math.min(usableD, Math.max(15, Math.round(order.depthMm ?? estSide)));
        const unitCount = Math.min(order.quantity, 20);

        for (let idx = 1; idx <= unitCount; idx++) {
          const unit: ExpandedUnit = {
            orderId: order.orderId,
            orderCode: order.orderCode,
            filename: order.filename,
            unitIndex: idx,
            w,
            d,
            grams: order.estimatedGrams,
            priority: order.priority,
          };
          if (w * d >= usableArea * largeRatio) {
            largeUnits.push(unit);
          } else {
            smallUnits.push(unit);
          }
        }
      }

      // 1. Large parts each get their own isolated plate (protects expensive long prints)
      for (const big of largeUnits) {
        const xMm = Math.round((plateW - big.w) / 2);
        const yMm = Math.round((plateD - big.d) / 2);
        plates.push({
          plateIndex: plateCounter++,
          materialCode,
          materialName,
          plateWidthMm: plateW,
          plateDepthMm: plateD,
          isolated: true,
          reason: 'Large part — isolated on dedicated plate to reduce batch failure risk',
          utilizationPercent: Math.min(100, Math.round(((big.w * big.d) / usableArea) * 100)),
          totalGrams: Math.round(big.grams * 10) / 10,
          items: [
            {
              orderId: big.orderId,
              orderCode: big.orderCode,
              filename: big.filename,
              unitIndex: big.unitIndex,
              xMm,
              yMm,
              widthMm: big.w,
              depthMm: big.d,
              priority: big.priority,
            },
          ],
        });
      }

      // 2. Small parts: Express first, then largest depth first (Shelf FFDH bin packing)
      smallUnits.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority === 'express' ? -1 : 1;
        return b.d - a.d || b.w - a.w;
      });

      interface OpenShelf {
        y: number;
        height: number;
        cursorX: number;
      }

      interface WorkingPlate {
        shelves: OpenShelf[];
        items: PlacedItem[];
        usedArea: number;
        totalGrams: number;
      }

      const openPlates: WorkingPlate[] = [];

      const tryPlaceOnPlate = (wp: WorkingPlate, u: ExpandedUnit): boolean => {
        if (wp.items.length >= maxParts) return false;
        if ((wp.usedArea + u.w * u.d) / usableArea > 0.72) return false;

        // Try existing shelves first
        for (const shelf of wp.shelves) {
          if (u.d <= shelf.height && shelf.cursorX + u.w <= margin + usableW) {
            wp.items.push({
              orderId: u.orderId,
              orderCode: u.orderCode,
              filename: u.filename,
              unitIndex: u.unitIndex,
              xMm: shelf.cursorX,
              yMm: shelf.y,
              widthMm: u.w,
              depthMm: u.d,
              priority: u.priority,
            });
            shelf.cursorX += u.w + gap;
            wp.usedArea += u.w * u.d;
            wp.totalGrams += u.grams;
            return true;
          }
        }

        // Open a new shelf below the last one
        const nextY =
          wp.shelves.length === 0
            ? margin
            : wp.shelves[wp.shelves.length - 1].y + wp.shelves[wp.shelves.length - 1].height + gap;

        if (nextY + u.d <= margin + usableD && margin + u.w <= margin + usableW) {
          const shelf: OpenShelf = { y: nextY, height: u.d, cursorX: margin + u.w + gap };
          wp.shelves.push(shelf);
          wp.items.push({
            orderId: u.orderId,
            orderCode: u.orderCode,
            filename: u.filename,
            unitIndex: u.unitIndex,
            xMm: margin,
            yMm: nextY,
            widthMm: u.w,
            depthMm: u.d,
            priority: u.priority,
          });
          wp.usedArea += u.w * u.d;
          wp.totalGrams += u.grams;
          return true;
        }

        return false;
      };

      for (const unit of smallUnits) {
        let placed = false;
        for (const wp of openPlates) {
          if (tryPlaceOnPlate(wp, unit)) {
            placed = true;
            break;
          }
        }
        if (!placed) {
          const fresh: WorkingPlate = { shelves: [], items: [], usedArea: 0, totalGrams: 0 };
          tryPlaceOnPlate(fresh, unit);
          openPlates.push(fresh);
        }
      }

      for (const wp of openPlates) {
        // Center-balance each shelf row horizontally and center the full group vertically
        // on the heated bed (like OrcaSlicer / ElegooSlicer Auto-Arrange) so parts stay
        // in the thermal sweet spot instead of hugging the top-left corner.
        const rowsByY = new Map<number, PlacedItem[]>();
        for (const item of wp.items) {
          const row = rowsByY.get(item.yMm) ?? [];
          row.push(item);
          rowsByY.set(item.yMm, row);
        }

        for (const row of rowsByY.values()) {
          const rowMinX = Math.min(...row.map((i) => i.xMm));
          const rowMaxX = Math.max(...row.map((i) => i.xMm + i.widthMm));
          const rowWidth = rowMaxX - rowMinX;
          const targetStartX = Math.max(
            margin,
            Math.min(plateW - margin - rowWidth, Math.round((plateW - rowWidth) / 2)),
          );
          const dx = targetStartX - rowMinX;
          for (const item of row) {
            item.xMm += dx;
          }
        }

        if (wp.items.length > 0) {
          const minY = Math.min(...wp.items.map((i) => i.yMm));
          const maxY = Math.max(...wp.items.map((i) => i.yMm + i.depthMm));
          const groupDepth = maxY - minY;
          const targetStartY = Math.max(
            margin,
            Math.min(plateD - margin - groupDepth, Math.round((plateD - groupDepth) / 2)),
          );
          const dy = targetStartY - minY;
          for (const item of wp.items) {
            item.yMm += dy;
          }
        }

        plates.push({
          plateIndex: plateCounter++,
          materialCode,
          materialName,
          plateWidthMm: plateW,
          plateDepthMm: plateD,
          isolated: false,
          reason: `Center-balanced ${wp.items.length} small part(s) sharing ${materialCode}`,
          utilizationPercent: Math.min(100, Math.round((wp.usedArea / usableArea) * 100)),
          totalGrams: Math.round(wp.totalGrams * 10) / 10,
          items: wp.items,
        });
      }
    }

    return plates;
  }
}
