import prisma from '../utils/prisma';



export interface TransactionInput {
  type: 'deposit' | 'withdrawal';
  amount: number;
  date: string; // ISO date
  userId?: string;
}

export async function addTransaction(input: TransactionInput) {
  return prisma.transaction.create({
    data: {
      type: input.type,
      amount: input.amount,
      date: new Date(input.date),
      userId: input.userId ?? null,
    },
  });
}

export async function getTransactions(userId?: string | null, since?: Date) {
  return prisma.transaction.findMany({
    where: {
      userId: userId ?? null,
      ...(since ? { date: { gte: since } } : {}),
    },
    orderBy: { date: 'desc' },
  });
}

export async function deleteTransaction(id: string) {
  return prisma.transaction.delete({ where: { id } });
}

