import { Injectable } from '@nestjs/common';

export interface QuoteEstimateInput {
  estimatedGrams: number;
  pricePerGramVnd: number;
  quantity: number;
  priority: 'normal' | 'express';
}

export interface QuoteEstimateResult {
  estimatedGrams: number;
  estimatedSec: number;
  unitPriceVnd: number;
  discountPercent: number;
  priorityMultiplier: number;
  totalPriceVnd: number;
}

const MIN_ORDER_VND = 30_000;
const BASE_SETUP_FEE_VND = 15_000;
const EXPRESS_MULTIPLIER = 1.2;

/**
 * Deterministic pricing & print-time estimator for On-Demand orders (inspired by X3D Studios).
 * Uses real material density & per-gram rate with transparent volume breaks.
 * Ready to accept exact gram/time figures from OrcaSlicer CLI when configured.
 */
@Injectable()
export class SlicerQuoteService {
  calculateQuote(input: QuoteEstimateInput): QuoteEstimateResult {
    const grams = Math.max(1, Math.round(input.estimatedGrams * 10) / 10);
    const qty = Math.max(1, Math.min(500, Math.floor(input.quantity)));

    // Volume discount tiers
    const discountPercent = qty >= 50 ? 20 : qty >= 20 ? 12 : qty >= 10 ? 7 : qty >= 5 ? 3 : 0;
    const priorityMultiplier = input.priority === 'express' ? EXPRESS_MULTIPLIER : 1.0;

    // Average high-speed CoreXY throughput (~12g/hour ≈ 300s per gram)
    const estimatedSec = Math.round(grams * 300);

    const rawUnit = BASE_SETUP_FEE_VND + grams * input.pricePerGramVnd;
    const discountedUnit = rawUnit * (1 - discountPercent / 100) * priorityMultiplier;
    const unitPriceVnd = Math.ceil(discountedUnit / 1000) * 1000;
    const totalPriceVnd = Math.max(MIN_ORDER_VND, unitPriceVnd * qty);

    return {
      estimatedGrams: grams,
      estimatedSec,
      unitPriceVnd,
      discountPercent,
      priorityMultiplier,
      totalPriceVnd,
    };
  }
}
