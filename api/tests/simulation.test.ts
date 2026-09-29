import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { SimulationEngine } from '../src/services/simulation-engine.js';
import { SimulationRouteHandler } from '../src/routes/simulation.js';
import { PositionSimulationRequest } from '../src/types/index.js';

describe('SimulationEngine Unit & Integration Tests', () => {
  it('correctly calculates healthy position (HF > 1.5 => Safe)', () => {
    const request: PositionSimulationRequest = {
      collaterals: [
        {
          asset: 'XLM',
          amount: '10000',
          priceUsd: 1.0,
          liquidationThresholdBps: 8000, // 80% = $8,000
          collateralFactorBps: 7500,     // 75% = $7,500
        },
      ],
      borrows: [
        {
          asset: 'USDC',
          borrowedAmount: '4000',
          priceUsd: 1.0,
          borrowRateBps: 500,
        },
      ],
    };

    const res = SimulationEngine.simulate(request);

    // HF = $8000 / $4000 = 2.0 (20000 bps)
    expect(res.initialHealthFactor).toBe(2.0);
    expect(res.initialHealthFactorBps).toBe(20000);
    expect(res.simulatedRiskTier).toBe('Safe');
    expect(res.isLiquidatable).toBe(false);
    expect(res.shortfallUsd).toBe(0);
    expect(res.maxBorrowableUsd).toBe(3500); // 7500 - 4000
    expect(res.maxWithdrawableUsd).toBe(4000); // 8000 - 4000
    expect(res.liquidationPriceUsd).toBe(0.5); // $4000 / (10000 * 0.8)
  });

  it('correctly flags liquidatable position when HF < 1.0', () => {
    const request: PositionSimulationRequest = {
      collaterals: [
        {
          asset: 'XLM',
          amount: '1000',
          priceUsd: 1.0,
          liquidationThresholdBps: 8000, // $800
          collateralFactorBps: 7500,
        },
      ],
      borrows: [
        {
          asset: 'USDC',
          borrowedAmount: '900', // $900 debt > $800 threshold => HF = 0.8888
          priceUsd: 1.0,
          borrowRateBps: 500,
        },
      ],
    };

    const res = SimulationEngine.simulate(request);
    expect(res.initialHealthFactor).toBeLessThan(1.0);
    expect(res.simulatedRiskTier).toBe('Liquidatable');
    expect(res.isLiquidatable).toBe(true);
    expect(res.shortfallUsd).toBe(100);
  });

  it('simulates price shock on collateral and debt accurately', () => {
    const request: PositionSimulationRequest = {
      collaterals: [
        {
          asset: 'XLM',
          amount: '10000',
          priceUsd: 1.0,
          liquidationThresholdBps: 8000,
          collateralFactorBps: 7500,
        },
      ],
      borrows: [
        {
          asset: 'USDC',
          borrowedAmount: '4000',
          priceUsd: 1.0,
          borrowRateBps: 500,
        },
      ],
      priceShocks: [
        { asset: 'XLM', shockBps: -3000 }, // -30% drop in XLM price -> $0.70
      ],
    };

    const res = SimulationEngine.simulate(request);

    // Initial: $8000 / $4000 = 2.0
    expect(res.initialHealthFactor).toBe(2.0);
    // Simulated Col = $7000, Liq Threshold = $5600 -> HF = $5600 / $4000 = 1.4
    expect(res.simulatedCollateralUsd).toBe(7000);
    expect(res.simulatedHealthFactor).toBe(1.4);
    expect(res.simulatedRiskTier).toBe('Caution');
  });

  it('simulates time delta with accrued interest', () => {
    const request: PositionSimulationRequest = {
      collaterals: [
        {
          asset: 'XLM',
          amount: '10000',
          priceUsd: 1.0,
          liquidationThresholdBps: 8000,
          collateralFactorBps: 7500,
        },
      ],
      borrows: [
        {
          asset: 'USDC',
          borrowedAmount: '5000',
          priceUsd: 1.0,
          borrowRateBps: 1000, // 10% APY
        },
      ],
      timeDeltaSeconds: 31536000, // 1 year
    };

    const res = SimulationEngine.simulate(request);
    // 10% of 5000 is 500 interest -> Simulated Debt = $5500
    expect(res.simulatedDebtUsd).toBe(5500);
    // Simulated HF = 8000 / 5500 = 1.4545
    expect(res.simulatedHealthFactor).toBeCloseTo(1.4545, 2);
    expect(res.simulatedHealthFactorBps).toBe(14545);
  });

  it('handles multi-asset portfolio with stress test scenarios', () => {
    const request: PositionSimulationRequest = {
      collaterals: [
        { asset: 'XLM', amount: '5000', priceUsd: 1.0, liquidationThresholdBps: 8000, collateralFactorBps: 7500 },
        { asset: 'BTC', amount: '1', priceUsd: 50000, liquidationThresholdBps: 8500, collateralFactorBps: 8000 },
      ],
      borrows: [
        { asset: 'USDC', borrowedAmount: '20000', priceUsd: 1.0, borrowRateBps: 500 },
        { asset: 'EURC', borrowedAmount: '5000', priceUsd: 1.1, borrowRateBps: 400 },
      ],
    };

    const res = SimulationEngine.simulate(request);
    expect(res.stressScenarios.length).toBe(3);
    expect(res.stressScenarios[0].name).toContain('Mild Market Dip');
    expect(res.stressScenarios[1].name).toContain('Moderate Correction');
    expect(res.stressScenarios[2].name).toContain('Severe Black Swan');
  });

  it('rejects malformed requests gracefully via RouteHandler', () => {
    const res1 = SimulationRouteHandler.handleSimulate({});
    expect(res1.success).toBe(false);
    expect(res1.error?.code).toBe('MISSING_COLLATERALS');

    const res2 = SimulationRouteHandler.handleSimulate({
      collaterals: [{ asset: 'XLM', amount: '100', priceUsd: -5 }],
    });
    // Sanitizer clamps negative price to default
    expect(res2.success).toBe(true);
  });

  it('Property Test: Health factor is strictly positive for any positive collateral and debt', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_000_000 }),
        fc.integer({ min: 100, max: 1_000_000 }),
        fc.integer({ min: 1000, max: 9500 }),
        (colAmount, debtAmount, liqBps) => {
          const req: PositionSimulationRequest = {
            collaterals: [{ asset: 'XLM', amount: colAmount.toString(), priceUsd: 1.0, liquidationThresholdBps: liqBps, collateralFactorBps: liqBps - 500 }],
            borrows: [{ asset: 'USDC', borrowedAmount: debtAmount.toString(), priceUsd: 1.0, borrowRateBps: 500 }],
          };
          const res = SimulationEngine.simulate(req);
          expect(res.simulatedHealthFactor).toBeGreaterThan(0);
          expect(res.simulatedHealthFactorBps).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Simulation Engine Extended Coverage', () => {
  it('applies collateral deltas and debt deltas', () => {
    const request: PositionSimulationRequest = {
      collaterals: [
        { asset: 'XLM', amount: '10000', priceUsd: 1.0, liquidationThresholdBps: 8000, collateralFactorBps: 7500 },
      ],
      borrows: [
        { asset: 'USDC', borrowedAmount: '4000', priceUsd: 1.0, borrowRateBps: 500 },
      ],
      collateralDeltas: [
        { asset: 'XLM', deltaAmount: '-2000' }, // Withdraw 2000 XLM -> 8000 left
      ],
      debtDeltas: [
        { asset: 'USDC', deltaAmount: '1000' }, // Borrow 1000 more -> 5000 debt
      ],
    };

    const res = SimulationEngine.simulate(request);
    expect(res.simulatedCollateralUsd).toBe(8000);
    expect(res.simulatedDebtUsd).toBe(5000);
    expect(res.simulatedLiquidationThresholdUsd).toBe(6400);
    expect(res.simulatedHealthFactor).toBe(1.28);
    expect(res.simulatedRiskTier).toBe('Caution');
  });

  it('handles multiple assets with price shock in opposite directions', () => {
    const request: PositionSimulationRequest = {
      collaterals: [
        { asset: 'XLM', amount: '10000', priceUsd: 1.0, liquidationThresholdBps: 8000, collateralFactorBps: 7500 },
        { asset: 'ETH', amount: '1', priceUsd: 3000, liquidationThresholdBps: 8500, collateralFactorBps: 8000 },
      ],
      borrows: [
        { asset: 'USDC', borrowedAmount: '5000', priceUsd: 1.0, borrowRateBps: 500 },
      ],
      priceShocks: [
        { asset: 'XLM', shockBps: 5000 }, // +50% surge
        { asset: 'ETH', shockBps: -5000 }, // -50% plunge
      ],
    };

    const res = SimulationEngine.simulate(request);
    // XLM: 10000 * 1.5 = 15000. ETH: 1 * 1500 = 1500. Total = 16500
    expect(res.simulatedCollateralUsd).toBe(16500);
    expect(res.simulatedHealthFactor).toBeGreaterThan(2.0);
  });
});

// ── Issue #1277: array-length caps and per-element delta validation ───────────

import {
  MAX_COLLATERALS,
  MAX_BORROWS,
  MAX_PRICE_SHOCKS,
  MAX_COLLATERAL_DELTAS,
  MAX_DEBT_DELTAS,
} from '../src/routes/simulation.js';
import { SecuritySanitizer } from '../src/middleware/security.js';

const baseCollateral = {
  asset: 'XLM',
  amount: '1000',
  priceUsd: 1,
  liquidationThresholdBps: 8000,
  collateralFactorBps: 7500,
};

describe('#1277 array-length caps', () => {
  it('accepts exactly MAX_COLLATERALS collaterals', () => {
    const res = SimulationRouteHandler.handleSimulate({
      collaterals: Array(MAX_COLLATERALS).fill(baseCollateral),
    });
    expect(res.success).toBe(true);
  });

  it('rejects collaterals above the cap with INPUT_TOO_LARGE', () => {
    const res = SimulationRouteHandler.handleSimulate({
      collaterals: Array(MAX_COLLATERALS + 1).fill(baseCollateral),
    });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('INPUT_TOO_LARGE');
    expect(res.error?.message).toMatch(/collaterals/);
  });

  it('rejects borrows above the cap with INPUT_TOO_LARGE', () => {
    const borrow = { asset: 'USDC', borrowedAmount: '100', priceUsd: 1, borrowRateBps: 500 };
    const res = SimulationRouteHandler.handleSimulate({
      collaterals: [baseCollateral],
      borrows: Array(MAX_BORROWS + 1).fill(borrow),
    });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('INPUT_TOO_LARGE');
    expect(res.error?.message).toMatch(/borrows/);
  });

  it('rejects priceShocks above the cap with INPUT_TOO_LARGE', () => {
    const res = SimulationRouteHandler.handleSimulate({
      collaterals: [baseCollateral],
      priceShocks: Array(MAX_PRICE_SHOCKS + 1).fill({ asset: 'XLM', shockBps: -1000 }),
    });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('INPUT_TOO_LARGE');
    expect(res.error?.message).toMatch(/priceShocks/);
  });

  it('rejects collateralDeltas above the cap with INPUT_TOO_LARGE', () => {
    const res = SimulationRouteHandler.handleSimulate({
      collaterals: [baseCollateral],
      collateralDeltas: Array(MAX_COLLATERAL_DELTAS + 1).fill({ asset: 'XLM', deltaAmount: '1' }),
    });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('INPUT_TOO_LARGE');
    expect(res.error?.message).toMatch(/collateralDeltas/);
  });

  it('rejects debtDeltas above the cap with INPUT_TOO_LARGE', () => {
    const res = SimulationRouteHandler.handleSimulate({
      collaterals: [baseCollateral],
      debtDeltas: Array(MAX_DEBT_DELTAS + 1).fill({ asset: 'USDC', deltaAmount: '1' }),
    });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('INPUT_TOO_LARGE');
    expect(res.error?.message).toMatch(/debtDeltas/);
  });

  it('length check fires before any loop — the cap protects against event-loop blockage', () => {
    // A 201-entry collateralDeltas against a 200-entry collaterals would be
    // 40,000 BigInt iterations.  The cap kicks in at validation time so the
    // engine is never entered.
    const start = Date.now();
    const res = SimulationRouteHandler.handleSimulate({
      collaterals: Array(MAX_COLLATERALS).fill(baseCollateral),
      collateralDeltas: Array(MAX_COLLATERAL_DELTAS + 1).fill({ asset: 'XLM', deltaAmount: '1' }),
    });
    expect(Date.now() - start).toBeLessThan(50); // well under any loop cost
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('INPUT_TOO_LARGE');
  });
});

describe('#1277 per-element delta validation', () => {
  it('rejects a collateralDelta entry that is not an object', () => {
    const res = SimulationRouteHandler.handleSimulate({
      collaterals: [baseCollateral],
      collateralDeltas: ['not-an-object'],
    });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('INVALID_INPUT');
    expect(res.error?.message).toMatch(/collateralDeltas\[0\]/);
  });

  it('rejects a collateralDelta with missing asset', () => {
    const res = SimulationRouteHandler.handleSimulate({
      collaterals: [baseCollateral],
      collateralDeltas: [{ asset: '', deltaAmount: '100' }],
    });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('INVALID_INPUT');
    expect(res.error?.message).toMatch(/collateralDeltas\[0\]\.asset/);
  });

  it('rejects a collateralDelta with invalid deltaAmount', () => {
    for (const bad of ['1.5', 'abc', '1e5', null, undefined, {}, '']) {
      const res = SimulationRouteHandler.handleSimulate({
        collaterals: [baseCollateral],
        collateralDeltas: [{ asset: 'XLM', deltaAmount: bad }],
      });
      expect(res.success, `expected failure for deltaAmount=${String(bad)}`).toBe(false);
      expect(res.error?.code).toBe('INVALID_INPUT');
      expect(res.error?.message).toMatch(/collateralDeltas\[0\]\.deltaAmount/);
    }
  });

  it('accepts collateralDeltas with valid signed integer strings', () => {
    const res = SimulationRouteHandler.handleSimulate({
      collaterals: [baseCollateral],
      collateralDeltas: [
        { asset: 'XLM', deltaAmount: '500' },
        { asset: 'XLM', deltaAmount: '-200' },
        { asset: 'XLM', deltaAmount: '0' },
      ],
    });
    expect(res.success).toBe(true);
  });

  it('rejects a debtDelta entry that is not an object', () => {
    const res = SimulationRouteHandler.handleSimulate({
      collaterals: [baseCollateral],
      debtDeltas: [42],
    });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('INVALID_INPUT');
    expect(res.error?.message).toMatch(/debtDeltas\[0\]/);
  });

  it('rejects a debtDelta with missing asset', () => {
    const res = SimulationRouteHandler.handleSimulate({
      collaterals: [baseCollateral],
      debtDeltas: [{ deltaAmount: '100' }],
    });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('INVALID_INPUT');
    expect(res.error?.message).toMatch(/debtDeltas\[0\]\.asset/);
  });

  it('rejects a debtDelta with invalid deltaAmount', () => {
    for (const bad of ['3.14', 'NaN', '0x10', null, [], '']) {
      const res = SimulationRouteHandler.handleSimulate({
        collaterals: [baseCollateral],
        debtDeltas: [{ asset: 'USDC', deltaAmount: bad }],
      });
      expect(res.success, `expected failure for debtDelta deltaAmount=${String(bad)}`).toBe(false);
      expect(res.error?.code).toBe('INVALID_INPUT');
      expect(res.error?.message).toMatch(/debtDeltas\[0\]\.deltaAmount/);
    }
  });

  it('accepts debtDeltas with valid signed integer strings', () => {
    const res = SimulationRouteHandler.handleSimulate({
      collaterals: [baseCollateral],
      debtDeltas: [
        { asset: 'USDC', deltaAmount: '1000' },
        { asset: 'USDC', deltaAmount: '-500' },
      ],
    });
    expect(res.success).toBe(true);
  });

  it('reports the correct index in the error message for a mid-array invalid entry', () => {
    const res = SimulationRouteHandler.handleSimulate({
      collaterals: [baseCollateral],
      collateralDeltas: [
        { asset: 'XLM', deltaAmount: '100' },
        { asset: 'XLM', deltaAmount: '200' },
        { asset: 'XLM', deltaAmount: 'bad!' }, // index 2
      ],
    });
    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/collateralDeltas\[2\]/);
  });
});

describe('#1277 SecuritySanitizer.isValidBigIntString', () => {
  it('accepts plain positive and zero integer strings', () => {
    for (const v of ['0', '1', '999', '1000000']) {
      expect(SecuritySanitizer.isValidBigIntString(v), v).toBe(true);
    }
  });

  it('accepts negative integer strings', () => {
    for (const v of ['-1', '-500', '-1000000']) {
      expect(SecuritySanitizer.isValidBigIntString(v), v).toBe(true);
    }
  });

  it('rejects decimals, scientific notation, whitespace, and non-numeric input', () => {
    for (const v of ['1.5', '1e5', ' 10', '10 ', '', 'abc', null, undefined, {}, [], '0x1F']) {
      expect(SecuritySanitizer.isValidBigIntString(v), String(v)).toBe(false);
    }
  });

  it('accepts numeric values coerced to string', () => {
    expect(SecuritySanitizer.isValidBigIntString(100)).toBe(true);
    expect(SecuritySanitizer.isValidBigIntString(-50)).toBe(true);
  });
});
