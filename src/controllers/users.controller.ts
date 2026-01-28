import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { getUserPortfolio } from '../services/user-portfolio.service';

const prisma = new PrismaClient();

export async function getUsersHandler(req: Request, res: Response): Promise<void> {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        username: true,
        displayName: true,
        createdAt: true,
      },
    });
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
}

export async function getUserPortfolioHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const portfolio = await getUserPortfolio(userId);

    if (!portfolio) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json(portfolio);
  } catch (error) {
    console.error('Error fetching user portfolio:', error);
    res.status(500).json({ error: 'Failed to fetch user portfolio' });
  }
}
