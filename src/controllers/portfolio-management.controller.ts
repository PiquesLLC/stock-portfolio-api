import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import {
  listPortfolios,
  createPortfolio,
  updatePortfolio,
  deletePortfolio,
  setDefaultPortfolio,
  getPortfolioDetail,
} from '../services/portfolio-management.service';
import {
  portfolioIdParamSchema,
  createPortfolioSchema,
  updatePortfolioSchema,
} from '../validators/portfolio-management.validators';
import { PlanLimitError } from '../utils/plan-limit.error';

export async function listPortfoliosHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const portfolios = await listPortfolios(req.user!.userId);
    res.json(portfolios);
  } catch (error) {
    console.error('Error listing portfolios:', error);
    res.status(500).json({ error: 'Failed to list portfolios' });
  }
}

export async function getPortfolioDetailHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsed = portfolioIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid portfolio ID' });
      return;
    }

    const detail = await getPortfolioDetail(req.user!.userId, parsed.data.id);
    if (!detail) {
      res.status(404).json({ error: 'Portfolio not found' });
      return;
    }

    res.json(detail);
  } catch (error) {
    console.error('Error getting portfolio detail:', error);
    res.status(500).json({ error: 'Failed to get portfolio' });
  }
}

export async function createPortfolioHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsed = createPortfolioSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const portfolio = await createPortfolio(req.user!.userId, parsed.data);
    res.status(201).json(portfolio);
  } catch (error) {
    if (error instanceof PlanLimitError) {
      res.status(403).json({ error: 'limit_reached', limit: error.limit, plan: error.plan });
      return;
    }
    // P2002: unique constraint violation (duplicate name)
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'A portfolio with that name already exists' });
      return;
    }
    console.error('Error creating portfolio:', error);
    res.status(500).json({ error: 'Failed to create portfolio' });
  }
}

export async function updatePortfolioHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsedParams = portfolioIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: 'Invalid portfolio ID' });
      return;
    }
    const parsedBody = updatePortfolioSchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const updated = await updatePortfolio(req.user!.userId, parsedParams.data.id, parsedBody.data);
    if (!updated) {
      res.status(404).json({ error: 'Portfolio not found' });
      return;
    }

    res.json(updated);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'A portfolio with that name already exists' });
      return;
    }
    console.error('Error updating portfolio:');
    res.status(500).json({ error: 'Failed to update portfolio' });
  }
}

export async function deletePortfolioHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsed = portfolioIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid portfolio ID' });
      return;
    }

    const result = await deletePortfolio(req.user!.userId, parsed.data.id);

    if (result.status === 'not_found') {
      res.status(404).json({ error: 'Portfolio not found' });
      return;
    }
    if (result.status === 'is_default') {
      res.status(400).json({ error: 'Cannot delete the default portfolio' });
      return;
    }
    if (result.status === 'has_holdings') {
      res.status(400).json({ error: 'Cannot delete portfolio with holdings', holdingsCount: result.count });
      return;
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting portfolio:', error);
    res.status(500).json({ error: 'Failed to delete portfolio' });
  }
}

export async function setDefaultPortfolioHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsed = portfolioIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid portfolio ID' });
      return;
    }

    const result = await setDefaultPortfolio(req.user!.userId, parsed.data.id);
    if (!result) {
      res.status(404).json({ error: 'Portfolio not found' });
      return;
    }

    res.json({ id: result.id, name: result.name, isDefault: true });
  } catch (error) {
    console.error('Error setting default portfolio:', error);
    res.status(500).json({ error: 'Failed to set default portfolio' });
  }
}
