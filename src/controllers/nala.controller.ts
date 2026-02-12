import { Request, Response } from 'express';
import { AuthRequest } from '../types/auth';
import { askNala, NalaSuggestionsResponse } from '../services/nala-research.service';

const AI_PREMIUM_ENABLED = process.env.AI_PREMIUM_ENABLED === 'true';

function requirePremium(res: Response): boolean {
  if (AI_PREMIUM_ENABLED) return true;
  res.status(402).json({
    error: 'Premium feature',
    code: 'premium_required',
  });
  return false;
}

export async function askNalaHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requirePremium(res)) return;
    const { question } = req.body;

    if (!question || typeof question !== 'string' || question.trim().length < 5) {
      res.status(400).json({ error: 'Question must be at least 5 characters' });
      return;
    }

    if (question.length > 500) {
      res.status(400).json({ error: 'Question too long (max 500 characters)' });
      return;
    }

    const userId = req.user?.userId;
    const result = await askNala(question.trim(), userId);
    res.json(result);
  } catch (error) {
    console.error('[Nala Controller] Error:', error);
    res.status(500).json({
      error: 'Failed to process research question',
      ...(process.env.NODE_ENV !== 'production' ? { details: (error as Error)?.message } : {}),
      question: req.body?.question || '',
      stocks: [],
      strategy: null,
      strategyExplanation: '',
      citations: [],
      generatedAt: new Date().toISOString(),
      cached: false,
    });
  }
}

export async function getSuggestionsHandler(_req: Request, res: Response): Promise<void> {
  if (!requirePremium(res)) return;
  const suggestions: NalaSuggestionsResponse = {
    suggestions: [
      { text: 'Show me 5 stocks Warren Buffett would like', icon: '🏛️' },
      { text: 'Best growth stocks under $50', icon: '📈' },
      { text: 'Conservative dividend stocks for retirement', icon: '💰' },
      { text: 'Quality compounders with strong moats', icon: '🏰' },
      { text: 'Beaten down stocks ready for a turnaround', icon: '🔄' },
      { text: 'Best REITs for passive income', icon: '🏢' },
      { text: 'Small cap value stocks with hidden potential', icon: '💎' },
      { text: 'High momentum stocks trending up', icon: '🚀' },
    ],
  };
  res.json(suggestions);
}
