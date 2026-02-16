import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { addTransaction, getTransactions, deleteTransaction } from '../services/transaction.service';

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
    const { type, amount, date } = req.body;

    if (!type || !['deposit', 'withdrawal'].includes(type)) {
      res.status(400).json({ error: 'type must be "deposit" or "withdrawal"' });
      return;
    }
    if (typeof amount !== 'number' || amount <= 0) {
      res.status(400).json({ error: 'amount must be a positive number' });
      return;
    }
    if (!date) {
      res.status(400).json({ error: 'date is required (ISO format)' });
      return;
    }

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
    const { id } = req.params;
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
