import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { addTransaction, getTransactions, deleteTransaction } from '../services/transaction.service';
import { addTransactionSchema, transactionIdParamSchema } from '../validators/transaction.validators';

export async function getTransactionsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId || null;
    const transactions = await getTransactions(userId);
    res.json(transactions);
  } catch (error) {
    console.error('Error fetching transactions:');
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
}

export async function addTransactionHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsed = addTransactionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { type, amount, date } = parsed.data;

    // Always use authenticated user's ID
    const tx = await addTransaction({ type, amount, date, userId: req.user!.userId });
    res.status(201).json(tx);
  } catch (error) {
    console.error('Error adding transaction:');
    res.status(500).json({ error: 'Failed to add transaction' });
  }
}

export async function deleteTransactionHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsed = transactionIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { id } = parsed.data;
    // Ownership-scoped delete
    const deleted = await deleteTransaction(id, req.user!.userId);
    if (!deleted) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting transaction:');
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
}
