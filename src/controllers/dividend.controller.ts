import { Request, Response } from 'express';
import { createDividend, getDividends, deleteDividend } from '../services/dividend.service';

export async function addDividend(req: Request, res: Response): Promise<void> {
  try {
    const { ticker, amount, date } = req.body;

    if (!ticker || typeof ticker !== 'string') {
      res.status(400).json({ error: 'Missing or invalid ticker' });
      return;
    }

    if (typeof amount !== 'number' || amount <= 0) {
      res.status(400).json({ error: 'Invalid amount: must be a positive number' });
      return;
    }

    if (!date || typeof date !== 'string') {
      res.status(400).json({ error: 'Missing or invalid date (ISO format required)' });
      return;
    }

    // Validate date format
    const parsedDate = new Date(date);
    if (isNaN(parsedDate.getTime())) {
      res.status(400).json({ error: 'Invalid date format' });
      return;
    }

    const dividend = await createDividend({ ticker, amount, date });
    res.status(201).json(dividend);
  } catch (error) {
    console.error('Error adding dividend:', error);
    res.status(500).json({ error: 'Failed to add dividend' });
  }
}

export async function getDividendsHandler(req: Request, res: Response): Promise<void> {
  try {
    const dividends = await getDividends();
    res.json(dividends);
  } catch (error) {
    console.error('Error fetching dividends:', error);
    res.status(500).json({ error: 'Failed to fetch dividends' });
  }
}

export async function removeDividend(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    if (!id) {
      res.status(400).json({ error: 'Missing dividend id' });
      return;
    }

    await deleteDividend(id);
    res.status(204).send();
  } catch (error: any) {
    if (error?.code === 'P2025') {
      res.status(404).json({ error: 'Dividend not found' });
      return;
    }
    console.error('Error removing dividend:', error);
    res.status(500).json({ error: 'Failed to remove dividend' });
  }
}
