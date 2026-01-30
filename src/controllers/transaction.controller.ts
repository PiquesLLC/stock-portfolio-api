import { Request, Response } from 'express';
import { addTransaction, getTransactions, deleteTransaction } from '../services/transaction.service';

export async function getTransactionsHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.query.userId as string | undefined;
    const transactions = await getTransactions(userId || null);
    res.json(transactions);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
}

export async function addTransactionHandler(req: Request, res: Response): Promise<void> {
  try {
    const { type, amount, date, userId } = req.body;

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

    const tx = await addTransaction({ type, amount, date, userId });
    res.status(201).json(tx);
  } catch (error) {
    console.error('Error adding transaction:', error);
    res.status(500).json({ error: 'Failed to add transaction' });
  }
}

export async function deleteTransactionHandler(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await deleteTransaction(id);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting transaction:', error);
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
}
