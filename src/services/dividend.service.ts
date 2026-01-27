import { PrismaClient } from '@prisma/client';
import { DividendEvent, DividendInput } from '../types';

const prisma = new PrismaClient();

export async function createDividend(input: DividendInput): Promise<DividendEvent> {
  const dividend = await prisma.dividendEvent.create({
    data: {
      ticker: input.ticker.toUpperCase(),
      amount: input.amount,
      date: new Date(input.date),
    },
  });

  return dividend;
}

export async function getDividends(): Promise<DividendEvent[]> {
  return prisma.dividendEvent.findMany({
    orderBy: { date: 'desc' },
  });
}

export async function getDividendsBetween(startDate: Date, endDate: Date): Promise<DividendEvent[]> {
  return prisma.dividendEvent.findMany({
    where: {
      date: {
        gte: startDate,
        lte: endDate,
      },
    },
    orderBy: { date: 'asc' },
  });
}

export async function getTotalDividendsBetween(startDate: Date, endDate: Date): Promise<number> {
  const dividends = await getDividendsBetween(startDate, endDate);
  return dividends.reduce((sum, d) => sum + d.amount, 0);
}

export async function deleteDividend(id: string): Promise<void> {
  await prisma.dividendEvent.delete({
    where: { id },
  });
}
