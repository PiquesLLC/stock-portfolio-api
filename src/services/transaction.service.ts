import prisma from '../utils/prisma';



export interface TransactionInput {
  type: 'deposit' | 'withdrawal';
  amount: number;
  date: string; // ISO date
  userId: string;
}

export async function addTransaction(input: TransactionInput) {
  return prisma.transaction.create({
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
  });
}

export async function deleteTransaction(id: string, userId: string): Promise<boolean> {
  // Verify ownership before deleting
  const tx = await prisma.transaction.findFirst({ where: { id, userId } });
  if (!tx) return false;
  await prisma.transaction.delete({ where: { id } });
  return true;
}
