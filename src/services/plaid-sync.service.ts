import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { config } from '../config';
import prisma from '../utils/prisma';
import { getDecryptedAccessToken } from './plaid.service';
import { parseOccSymbol, isExpired } from '../utils/occ-parser';

export interface SkippedHolding {
  ticker: string | null;
  name: string | null;
  reason: string;
}

export interface SyncResult {
  created: number;
  updated: number;
  skipped: number;
  tickers: string[];
  skippedDetails: SkippedHolding[];
}

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[config.plaidEnv],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': config.plaidClientId,
      'PLAID-SECRET': config.plaidSecret,
    },
  },
});

const plaidClient = new PlaidApi(plaidConfig);

interface AggregatedHolding {
  quantity: number;
  totalCostBasis: number;
  holdingType: 'equity' | 'option';
  optionUnderlying?: string;
  optionStrike?: number;
  optionExpiry?: string;
  optionType?: 'call' | 'put';
}

export async function syncHoldingsFromPlaid(plaidItemId: string, userId: string): Promise<SyncResult> {
  const accessToken = await getDecryptedAccessToken(plaidItemId, userId);
  if (!accessToken) {
    throw new Error('Plaid item not found or inactive');
  }

  const response = await plaidClient.investmentsHoldingsGet({ access_token: accessToken });
  const securitiesById = new Map(response.data.securities.map((security) => [security.security_id, security]));

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const touchedTickers = new Set<string>();
  const skippedDetails: SkippedHolding[] = [];

  const aggregated = new Map<string, AggregatedHolding>();

  // Security types we can't price or display — skip during sync
  const SKIP_TYPES = new Set(['cryptocurrency']);
  // Internal Plaid IDs that aren't real tickers (e.g., NHX105509)
  const INTERNAL_ID_RE = /^[A-Z]{2,4}\d{5,}$/;

  for (const plaidHolding of response.data.holdings) {
    const security = securitiesById.get(plaidHolding.security_id);
    const ticker = security?.ticker_symbol?.trim().toUpperCase();

    if (!ticker) {
      skipped += 1;
      skippedDetails.push({ ticker: null, name: security?.name ?? null, reason: 'No ticker symbol available' });
      continue;
    }

    // Skip crypto
    if (security?.type === 'cryptocurrency') {
      skipped += 1;
      skippedDetails.push({ ticker, name: security?.name ?? null, reason: 'Cryptocurrency — coming soon' });
      continue;
    }
    if (SKIP_TYPES.has(security?.type ?? '')) {
      skipped += 1;
      skippedDetails.push({ ticker, name: security?.name ?? null, reason: `Unsupported security type: ${security?.type}` });
      continue;
    }

    // Handle derivatives (options contracts)
    if (security?.type === 'derivative') {
      const parsed = parseOccSymbol(ticker);
      if (!parsed) {
        skipped += 1;
        skippedDetails.push({ ticker, name: security?.name ?? null, reason: 'Unrecognized options contract format' });
        continue;
      }
      if (isExpired(parsed.expiry)) {
        skipped += 1;
        skippedDetails.push({ ticker, name: security?.name ?? null, reason: `Expired (${parsed.expiry})` });
        continue;
      }

      const quantity = typeof plaidHolding.quantity === 'number' ? plaidHolding.quantity : null;
      if (quantity == null || !Number.isFinite(quantity) || quantity <= 0) {
        skipped += 1;
        skippedDetails.push({ ticker, name: security?.name ?? null, reason: 'Invalid quantity' });
        continue;
      }

      const costBasis = typeof plaidHolding.cost_basis === 'number' && Number.isFinite(plaidHolding.cost_basis)
        ? plaidHolding.cost_basis
        : 0;

      const current = aggregated.get(ticker);
      if (!current) {
        aggregated.set(ticker, {
          quantity,
          totalCostBasis: costBasis,
          holdingType: 'option',
          optionUnderlying: parsed.underlying,
          optionStrike: parsed.strike,
          optionExpiry: parsed.expiry,
          optionType: parsed.type,
        });
      } else {
        current.quantity += quantity;
        current.totalCostBasis += costBasis;
      }
      continue;
    }

    // Skip internal Plaid IDs (e.g., NHX105509)
    if (INTERNAL_ID_RE.test(ticker) || ticker.length > 10) {
      skipped += 1;
      skippedDetails.push({ ticker, name: security?.name ?? null, reason: 'Invalid or internal identifier' });
      continue;
    }

    // Standard equity/ETF/mutual fund
    const quantity = typeof plaidHolding.quantity === 'number' ? plaidHolding.quantity : null;
    if (quantity == null || !Number.isFinite(quantity) || quantity <= 0) {
      skipped += 1;
      skippedDetails.push({ ticker, name: security?.name ?? null, reason: 'Invalid quantity' });
      continue;
    }

    const costBasis = typeof plaidHolding.cost_basis === 'number' && Number.isFinite(plaidHolding.cost_basis)
      ? plaidHolding.cost_basis
      : 0;
    const current = aggregated.get(ticker);
    if (!current) {
      aggregated.set(ticker, { quantity, totalCostBasis: costBasis, holdingType: 'equity' });
    } else {
      current.quantity += quantity;
      current.totalCostBasis += costBasis;
    }
  }

  for (const [ticker, aggregate] of aggregated) {
    const averageCost = aggregate.quantity > 0 ? aggregate.totalCostBasis / aggregate.quantity : 0;

    const existing = await prisma.holding.findFirst({
      where: { userId, ticker },
      select: { id: true, source: true },
    });

    if (!existing) {
      await prisma.holding.create({
        data: {
          userId,
          ticker,
          shares: aggregate.quantity,
          averageCost,
          source: 'plaid',
          holdingType: aggregate.holdingType,
          optionUnderlying: aggregate.optionUnderlying ?? null,
          optionStrike: aggregate.optionStrike ?? null,
          optionExpiry: aggregate.optionExpiry ?? null,
          optionType: aggregate.optionType ?? null,
        },
      });
      created += 1;
      touchedTickers.add(ticker);
      continue;
    }

    if (existing.source === 'plaid') {
      await prisma.holding.update({
        where: { id: existing.id },
        data: {
          shares: aggregate.quantity,
          averageCost,
          holdingType: aggregate.holdingType,
          optionUnderlying: aggregate.optionUnderlying ?? null,
          optionStrike: aggregate.optionStrike ?? null,
          optionExpiry: aggregate.optionExpiry ?? null,
          optionType: aggregate.optionType ?? null,
        },
      });
      updated += 1;
      touchedTickers.add(ticker);
      continue;
    }

    // Protect manually entered (manual/null) and csv imported holdings from Plaid overwrite.
    skipped += 1;
    skippedDetails.push({ ticker, name: null, reason: 'Already exists as manual/CSV holding' });
  }

  return {
    created,
    updated,
    skipped,
    tickers: Array.from(touchedTickers).sort(),
    skippedDetails,
  };
}
