import { describe, expect, it } from 'vitest';
import { SlicerQuoteService } from './slicer-quote.service';

describe('SlicerQuoteService', () => {
  const svc = new SlicerQuoteService();

  it('applies minimum order floor for very small parts', () => {
    const res = svc.calculateQuote({
      estimatedGrams: 5,
      pricePerGramVnd: 1200,
      quantity: 1,
      priority: 'normal',
    });
    expect(res.totalPriceVnd).toBe(30_000);
    expect(res.discountPercent).toBe(0);
  });

  it('applies volume discounts and express multiplier accurately', () => {
    const normal = svc.calculateQuote({
      estimatedGrams: 100,
      pricePerGramVnd: 1200,
      quantity: 20,
      priority: 'normal',
    });
    const express = svc.calculateQuote({
      estimatedGrams: 100,
      pricePerGramVnd: 1200,
      quantity: 20,
      priority: 'express',
    });
    expect(normal.discountPercent).toBe(12);
    expect(express.priorityMultiplier).toBe(1.2);
    expect(express.totalPriceVnd).toBeGreaterThan(normal.totalPriceVnd);
  });
});
