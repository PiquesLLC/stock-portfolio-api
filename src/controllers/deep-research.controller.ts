import { Response } from 'express';
import axios from 'axios';
import { AuthRequest } from '../types/auth';
import {
  startResearchSchema,
  followUpSchema,
  jobIdParamSchema,
  listJobsQuerySchema,
} from '../validators/deep-research.validators';
import {
  startDeepResearch,
  getJobStatus,
  getJobResult,
  submitFollowUp,
  cancelJob,
  listUserJobs,
  ConcurrentLimitError,
  MonthlyLimitError,
  FeatureDisabledError,
} from '../services/deep-research.service';

function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof FeatureDisabledError) {
    res.status(503).json({ error: err.message, code: 'feature_disabled' });
    return;
  }
  if (err instanceof ConcurrentLimitError) {
    res.status(429).json({ error: err.message, code: 'concurrent_limit' });
    return;
  }
  if (err instanceof MonthlyLimitError) {
    res.status(429).json({ error: err.message, code: 'monthly_limit' });
    return;
  }
  if (err instanceof Error && err.message === 'Job not found') {
    res.status(404).json({ error: 'Research job not found' });
    return;
  }
  if (err instanceof Error && err.message.startsWith('Cannot cancel')) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof Error && err.message.startsWith('Can only follow')) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof Error && err.message === 'Parent job not found') {
    res.status(404).json({ error: 'Parent research job not found' });
    return;
  }

  console.error('[Deep Research] Controller error:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error('[Deep Research] Stack:', err.stack);
  if (axios.isAxiosError(err) && err.response) {
    console.error('[Deep Research] Gemini API response:', err.response.status, JSON.stringify(err.response.data));
  }
  res.status(500).json({ error: 'Deep research operation failed' });
}

export async function startResearchHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsed = startResearchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
      return;
    }

    const userId = req.user!.userId;
    const { prompt, ticker, researchType, clientRequestId } = parsed.data;

    const result = await startDeepResearch(userId, prompt, {
      ticker,
      researchType,
      clientRequestId,
    });

    res.status(202).json(result);
  } catch (err) {
    handleServiceError(err, res);
  }
}

export async function getStatusHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const paramsParsed = jobIdParamSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      res.status(400).json({ error: 'Invalid job ID' });
      return;
    }

    const userId = req.user!.userId;
    const result = await getJobStatus(paramsParsed.data.id, userId);
    res.json(result);
  } catch (err) {
    handleServiceError(err, res);
  }
}

export async function getResultHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const paramsParsed = jobIdParamSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      res.status(400).json({ error: 'Invalid job ID' });
      return;
    }

    const userId = req.user!.userId;
    const result = await getJobResult(paramsParsed.data.id, userId);

    if (result.status !== 'completed' && result.status !== 'failed') {
      res.status(202).json({ id: result.id, status: result.status, message: 'Research still in progress' });
      return;
    }

    res.json(result);
  } catch (err) {
    handleServiceError(err, res);
  }
}

export async function followUpHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const paramsParsed = jobIdParamSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      res.status(400).json({ error: 'Invalid job ID' });
      return;
    }

    const bodyParsed = followUpSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: 'Invalid request', details: bodyParsed.error.flatten().fieldErrors });
      return;
    }

    const userId = req.user!.userId;
    const result = await submitFollowUp(paramsParsed.data.id, userId, bodyParsed.data.question);
    res.status(202).json(result);
  } catch (err) {
    handleServiceError(err, res);
  }
}

export async function cancelHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const paramsParsed = jobIdParamSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      res.status(400).json({ error: 'Invalid job ID' });
      return;
    }

    const userId = req.user!.userId;
    const result = await cancelJob(paramsParsed.data.id, userId);
    res.json(result);
  } catch (err) {
    handleServiceError(err, res);
  }
}

export async function listJobsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const queryParsed = listJobsQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      res.status(400).json({ error: 'Invalid query parameters', details: queryParsed.error.flatten().fieldErrors });
      return;
    }

    const userId = req.user!.userId;
    const result = await listUserJobs(userId, queryParsed.data);
    res.json(result);
  } catch (err) {
    handleServiceError(err, res);
  }
}
