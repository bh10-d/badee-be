import { describe, expect, it } from 'vitest';
import { PlateBatcherService } from './plate-batcher.service';

describe('PlateBatcherService (2D Bin Packing)', () => {
  const batcher = new PlateBatcherService();

  it('batches small same-material parts onto one plate and isolates large parts', () => {
    const plates = batcher.planBatches([
      {
        orderId: 'o1',
        orderCode: 'PF-1',
        filename: 'clip.stl',
        materialCode: 'PLA',
        materialName: 'PLA+',
        quantity: 3,
        priority: 'normal',
        estimatedGrams: 15,
        widthMm: 40,
        depthMm: 40,
      },
      {
        orderId: 'o2',
        orderCode: 'PF-2',
        filename: 'giant_case.stl',
        materialCode: 'PLA',
        materialName: 'PLA+',
        quantity: 1,
        priority: 'normal',
        estimatedGrams: 220,
        widthMm: 190,
        depthMm: 180,
      },
      {
        orderId: 'o3',
        orderCode: 'PF-3',
        filename: 'bracket.stl',
        materialCode: 'PETG',
        materialName: 'PETG',
        quantity: 2,
        priority: 'express',
        estimatedGrams: 30,
        widthMm: 50,
        depthMm: 40,
      },
    ]);

    // Expect: 1 isolated PLA plate for giant_case, 1 batched PLA plate for 3 clips, 1 batched PETG plate for 2 brackets
    expect(plates).toHaveLength(3);
    const isolated = plates.find((p) => p.isolated);
    expect(isolated?.items[0].filename).toBe('giant_case.stl');

    const plaBatch = plates.find((p) => !p.isolated && p.materialCode === 'PLA');
    expect(plaBatch?.items).toHaveLength(3);

    const petgBatch = plates.find((p) => p.materialCode === 'PETG');
    expect(petgBatch?.items).toHaveLength(2);
  });

  it('guarantees zero overlapping parts and keeps all items inside plate bounds', () => {
    const plates = batcher.planBatches([
      {
        orderId: 'o1',
        orderCode: 'PF-10',
        filename: 'knob.stl',
        materialCode: 'PLA',
        materialName: 'PLA+',
        quantity: 6,
        priority: 'normal',
        estimatedGrams: 20,
        widthMm: 55,
        depthMm: 55,
      },
    ]);

    for (const plate of plates) {
      const minX = Math.min(...plate.items.map((i) => i.xMm));
      const maxX = Math.max(...plate.items.map((i) => i.xMm + i.widthMm));
      const minY = Math.min(...plate.items.map((i) => i.yMm));
      const maxY = Math.max(...plate.items.map((i) => i.yMm + i.depthMm));
      // Bounding box must be centered on the 256x256 heated bed (not stuck in top-left corner)
      expect(Math.abs((minX + maxX) / 2 - 128)).toBeLessThanOrEqual(2);
      expect(Math.abs((minY + maxY) / 2 - 128)).toBeLessThanOrEqual(2);

      for (let i = 0; i < plate.items.length; i++) {
        const a = plate.items[i];
        expect(a.xMm).toBeGreaterThanOrEqual(15);
        expect(a.yMm).toBeGreaterThanOrEqual(15);
        expect(a.xMm + a.widthMm).toBeLessThanOrEqual(241);
        expect(a.yMm + a.depthMm).toBeLessThanOrEqual(241);
        for (let j = i + 1; j < plate.items.length; j++) {
          const b = plate.items[j];
          const overlaps =
            a.xMm < b.xMm + b.widthMm &&
            a.xMm + a.widthMm > b.xMm &&
            a.yMm < b.yMm + b.depthMm &&
            a.yMm + a.depthMm > b.yMm;
          expect(overlaps).toBe(false);
        }
      }
    }
  });
});
