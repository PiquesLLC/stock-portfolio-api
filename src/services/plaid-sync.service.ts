import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { config } from '../config';
import prisma from '../utils/prisma';
import { getDecryptedAccessToken } from './plaid.service';

export interface SyncResult {
  created: number;
  updated: number;
  skipped: number;
  tickers: string[];
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

  const aggregated = new Map<string, { quantity: number; totalCostBasis: number }>();

  for (const plaidHolding of response.data.holdings) {
    const security = securitiesById.get(plaidHolding.security_id);
    const ticker = security?.ticker_symbol?.trim().toUpperCase();

    if (!ticker) {
      skipped += 1;
      continue;
    }

    const quantity = typeof plaidHolding.quantity === 'number' ? plaidHolding.quantity : null;
    if (quantity === null || !Number.isFinite(quantity) || quantity < 0) {
      skipped += 1;
      continue;
    }

    const costBasis = typeof plaidHolding.cost_basis === 'number' && Number.isFinite(plaidHolding.cost_basis)
      ? plaidHolding.cost_basis
      : 0;
    const current = aggregated.get(ticker);
    if (!current) {
      aggregated.set(ticker, { quantity, totalCostBasis: costBasis });
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
        },
      });
      updated += 1;
      touchedTickers.add(ticker);
      continue;
    }

    // Protect manually entered (manual/null) and csv imported holdings from Plaid overwrite.
    skipped += 1;
  }

  return {
    created,
    updated,
    skipped,
    tickers: Array.from(touchedTickers).sort(),
  };
}
