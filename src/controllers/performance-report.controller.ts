import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { generatePerformanceReport } from '../services/performance-report.service';
import { PerformanceWindow } from '../services/benchmark.service';
import { getUserById } from '../services/auth.service';
import { sendPerformanceReport } from '../services/email.service';
import { validatePortfolioOwnership } from '../utils/validatePortfolioOwnership';

const VALID_PERIODS: PerformanceWindow[] = ['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y', 'ALL'];
const VALID_BENCHMARKS = ['SPY', 'QQQ', 'DIA'];

export async function getPerformanceReportHandler(req: AuthRequest, res: Response) {
  try {
    const period = ((req.query.period as string) || '1M').toUpperCase() as PerformanceWindow;
    const benchmark = ((req.query.benchmark as string) || 'SPY').toUpperCase();

    if (!VALID_PERIODS.includes(period)) {
      return res.status(400).json({ error: `Invalid period. Must be one of: ${VALID_PERIODS.join(', ')}` });
    }
    if (!VALID_BENCHMARKS.includes(benchmark)) {
      return res.status(400).json({ error: `Invalid benchmark. Must be one of: ${VALID_BENCHMARKS.join(', ')}` });
    }

    const portfolioId = req.query.portfolioId as string | undefined;
    await validatePortfolioOwnership(portfolioId, req.user!.userId);

    const theme = (req.query.theme as string) === 'dark' ? 'dark' : 'light';
    const html = await generatePerformanceReport(req.user!.userId, period, benchmark, theme, portfolioId);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[PerformanceReport] Generate error:', err);
    res.status(500).json({ error: 'Failed to generate report' });
  }
}

export async function emailPerformanceReportHandler(req: AuthRequest, res: Response) {
  try {
    const period = ((req.body?.period as string) || '1M').toUpperCase() as PerformanceWindow;
    const benchmark = ((req.body?.benchmark as string) || 'SPY').toUpperCase();

    if (!VALID_PERIODS.includes(period)) {
      return res.status(400).json({ error: `Invalid period. Must be one of: ${VALID_PERIODS.join(', ')}` });
    }
    if (!VALID_BENCHMARKS.includes(benchmark)) {
      return res.status(400).json({ error: `Invalid benchmark. Must be one of: ${VALID_BENCHMARKS.join(', ')}` });
    }

    const portfolioId = req.query.portfolioId as string | undefined;
    await validatePortfolioOwnership(portfolioId, req.user!.userId);

    const user = await getUserById(req.user!.userId);
    if (!user?.email) {
      return res.status(400).json({ error: 'No email address on file. Add an email in account settings.' });
    }

    const theme = (req.body?.theme as string) === 'dark' ? 'dark' : 'light';
    const html = await generatePerformanceReport(req.user!.userId, period, benchmark, theme, portfolioId);

    await sendPerformanceReport(user.email, html, period);

    res.json({ sent: true });
  } catch (err) {
    console.error('[PerformanceReport] Email error:', err);
    res.status(500).json({ error: 'Failed to email report' });
  }
}
