import prisma from '../utils/prisma';
import type { Prisma } from '../generated/prisma/client';



export interface TransactionInput {
  type: 'deposit' | 'withdrawal';
  amount: number;
  date: string; // ISO date
  userId: string;
}

/** Optional `db` lets callers make this atomic with a holding write (see
 *  addHolding/removeHolding — the compensating TWR cash-flow row must not be
 *  able to go missing while the position change commits). */
export async function addTransaction(
  input: TransactionInput,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return db.transaction.create({
    data: {
      type: input.type,
      amount: input.amount,
      date: new Date(input.date),
      userId: input.userId,
    },
  });
}

export async function getTransactions(userId: string, since?: Date) {
  return prisma.transaction.findMany({
    where: {
      userId,
      ...(since ? { date: { gte: since } } : {}),
    },
    orderBy: { date: 'desc' },
    take: 10000,
  });
}

export async function deleteTransaction(id: string, userId: string): Promise<boolean> {
  // Verify ownership before deleting
  const tx = await prisma.transaction.findFirst({ where: { id, userId } });
  if (!tx) return false;
  await prisma.transaction.delete({ where: { id } });
  return true;
}
