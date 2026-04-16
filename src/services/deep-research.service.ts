import axios from 'axios';
import { config } from '../config';
import { getPortfolio } from './portfolio.service';
import { extractJson } from '../utils/perplexity';
import prisma from '../utils/prisma';
import crypto from 'crypto';

// ─── Error Classes ──────────────────────────────────────────────────

export class ConcurrentLimitError extends Error {
  constructor(limit: number) {
    super(`Maximum concurrent deep research jobs reached (${limit})`);
    this.name = 'ConcurrentLimitError';
  }
}

export class MonthlyLimitError extends Error {
  constructor(limit: number, used: number) {
    super(`Monthly deep research limit reached (${used}/${limit})`);
    this.name = 'MonthlyLimitError';
  }
}

export class FeatureDisabledError extends Error {
  constructor() {
    super('NALA AI Deep Research is not currently available');
    this.name = 'FeatureDisabledError';
  }
}

// ─── Types ──────────────────────────────────────────────────────────

export interface DeepResearchReport {
  executiveSummary: string;
  bullCase: string;
  baseCase: string;
  bearCase: string;
  keyRisks: string[];
  keyCatalysts: string[];
  valuation: {
    method: string;
    comparables: string[];
    summary: string;
  };
  citations: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
  confidenceNotes: string;
}

interface GeminiInteractionResponse {
  id: string; // interaction ID
  status: string; // in_progress | completed | failed | cancelled | requires_action
  outputs?: Array<{
    type?: string;
    text?: string;
  }>;
  usage?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: {
    message: string;
    code?: number;
  };
}

// ─── Types for Thinking Summaries ────────────────────────────────────

export interface ThinkingSummary {
  text: string;
  timestamp: string;
  index: number;
}

// ─── Constants ──────────────────────────────────────────────────────

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEEP_RESEARCH_AGENT = 'deep-research-pro-preview-12-2025';
const FOLLOWUP_MODEL = 'gemini-2.5-pro-preview-05-06';
const MAX_POLL_COUNT = 360; // 360 × 15s = 90 min max
const PROMPT_TOKEN_BUDGET = 8000; // Aggressive cap on portfolio context tokens (~4 chars/token)
const PROMPT_CHAR_BUDGET = PROMPT_TOKEN_BUDGET * 4;
const INSTANCE_ID = crypto.randomUUID(); // Unique per process instance
const LEASE_DURATION_MS = 60_000; // 60s lease per poll cycle
const SUMMARY_FLUSH_INTERVAL_MS = 3_000; // Debounce thinking summary writes to DB

// ─── System Prompt ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `CRITICAL OUTPUT FORMAT: Your entire response must be a single valid JSON object matching the schema below. Do NOT include markdown prose, headings, tables, or narrative above or below the JSON. Do NOT wrap the JSON in \`\`\` fences. Return raw JSON only.

You are NALA AI, a senior investment research analyst producing institutional-quality deep research reports for retail investors.

Return ONLY valid JSON with this exact structure:
{
  "executiveSummary": "2-3 paragraph overview of findings",
  "bullCase": "Detailed bull case with specific catalysts and price implications",
  "baseCase": "Most likely scenario with key assumptions",
  "bearCase": "Detailed bear case with specific risks and downside scenarios",
  "keyRisks": ["risk1", "risk2", ...],
  "keyCatalysts": ["catalyst1", "catalyst2", ...],
  "valuation": {
    "method": "DCF | Comparables | Sum-of-parts | etc.",
    "comparables": ["TICKER1", "TICKER2"],
    "summary": "Valuation analysis summary with fair value range"
  },
  "citations": [
    { "title": "Source title", "url": "https://...", "snippet": "Key quote or data point" }
  ],
  "confidenceNotes": "Data quality assessment, gaps in analysis, and confidence level"
}

Rules:
- Be specific with numbers, dates, and company names
- Include at least 5 citations from recent, authoritative sources
- Distinguish between confirmed facts and analyst estimates
- Do NOT recommend buying or selling — present analysis for informed decision-making
- Flag any data gaps or low-confidence areas in confidenceNotes
- All monetary values in USD unless otherwise specified`;

// ─── Prompt Builder ─────────────────────────────────────────────────

/**
 * Pure function — composes the full LLM prompt from the three sections
 * (SYSTEM_PROMPT, portfolio context, user request) plus an optional
 * research-focus block when a ticker is supplied.
 *
 * Regression guard (Apr 16 2026): when a user requests deep research on a
 * specific ticker (e.g. LITE) but their free-text prompt is generic,
 * Gemini was latching onto the largest portfolio holding and writing the
 * report about that instead. The focus block is placed BEFORE the
 * portfolio context so the model reads the ticker constraint before it
 * sees any holdings.
 */
export function buildDeepResearchPrompt(
  portfolioContext: string,
  userPrompt: string,
  opts: { ticker?: string; researchType?: string }
): string {
  let focusBlock = '';
  if (opts.ticker) {
    const ticker = opts.ticker.toUpperCase();
    const typeLine = opts.researchType
      ? `Research type: ${opts.researchType}\n`
      : '';
    focusBlock =
      `--- RESEARCH FOCUS ---\n` +
      `Primary ticker: ${ticker}\n` +
      typeLine +
      `This report MUST be about ${ticker} and ONLY this ticker. ` +
      `Do NOT substitute a different company from the user's portfolio, ` +
      `even if other holdings are larger or more familiar. Every section ` +
      `(executive summary, bull/base/bear cases, valuation, catalysts, ` +
      `risks) must analyze ${ticker} specifically. The portfolio context ` +
      `below is provided only so you can note how ${ticker} fits alongside ` +
      `existing positions — it is NOT the subject of the report.\n\n`;
  } else if (opts.researchType) {
    focusBlock =
      `--- RESEARCH FOCUS ---\n` +
      `Research type: ${opts.researchType}\n\n`;
  }

  return (
    `${SYSTEM_PROMPT}\n\n` +
    focusBlock +
    `--- USER PORTFOLIO CONTEXT ---\n${portfolioContext}\n\n` +
    `--- USER RESEARCH REQUEST ---\n${userPrompt}`
  );
}

// ─── Portfolio Context Builder ──────────────────────────────────────

async function buildPortfolioContext(userId: string): Promise<string> {
  const portfolio = await getPortfolio(userId);

  if (portfolio.holdings.length === 0) {
    return 'Portfolio: No current holdings.';
  }

  // Top 25 holdings by value — exclude sensitive fields (userId, id, source)
  const holdingsSummary = portfolio.holdings
    .sort((a, b) => b.currentValue - a.currentValue)
    .slice(0, 25)
    .map(h => {
      const parts = [
        `${h.ticker}: ${h.shares} shares`,
        `value $${h.currentValue.toFixed(0)}`,
        `avg cost $${h.averageCost.toFixed(2)}`,
        `day ${h.dayChangePercent >= 0 ? '+' : ''}${h.dayChangePercent.toFixed(1)}%`,
        `P/L ${h.profitLossPercent >= 0 ? '+' : ''}${h.profitLossPercent.toFixed(1)}%`,
      ];
      return parts.join(', ');
    })
    .join('\n');

  // Enrich with fundamentals (P/E, ROE, margin, beta, sector)
  const tickers = portfolio.holdings.slice(0, 25).map(h => h.ticker);
  const fundamentals = await prisma.fundamentalsCache.findMany({
    where: { ticker: { in: tickers } },
    select: { ticker: true, overviewJson: true },
  });

  const fundMap = new Map<string, string>();
  for (const f of fundamentals) {
    if (!f.overviewJson) continue;
    try {
      const ov = JSON.parse(f.overviewJson);
      const parts: string[] = [];
      if (ov.Sector) parts.push(`sector: ${ov.Sector}`);
      if (ov.PERatio && ov.PERatio !== 'None') parts.push(`P/E: ${ov.PERatio}`);
      if (ov.ReturnOnEquityTTM && ov.ReturnOnEquityTTM !== 'None') parts.push(`ROE: ${ov.ReturnOnEquityTTM}`);
      if (ov.ProfitMargin && ov.ProfitMargin !== 'None') parts.push(`margin: ${ov.ProfitMargin}`);
      if (ov.Beta && ov.Beta !== 'None') parts.push(`beta: ${ov.Beta}`);
      if (parts.length > 0) fundMap.set(f.ticker, parts.join(', '));
    } catch { /* skip malformed */ }
  }

  let fundamentalsSummary = '';
  if (fundMap.size > 0) {
    fundamentalsSummary = '\n\nFundamentals:\n' + Array.from(fundMap.entries())
      .map(([ticker, info]) => `${ticker}: ${info}`)
      .join('\n');
  }

  let context =
    `Portfolio (${portfolio.holdings.length} positions, net equity $${portfolio.netEquity.toFixed(0)}):\n` +
    `Today's change: ${portfolio.dayChangePercent >= 0 ? '+' : ''}${portfolio.dayChangePercent.toFixed(1)}%\n\n` +
    `Holdings:\n${holdingsSummary}` +
    fundamentalsSummary;

  // Truncate to token budget
  if (context.length > PROMPT_CHAR_BUDGET) {
    context = context.slice(0, PROMPT_CHAR_BUDGET) + '\n[...truncated for token budget]';
  }

  return context;
}

// ─── Gemini HTTP Layer ──────────────────────────────────────────────

async function createGeminiInteraction(
  prompt: string,
  opts?: { previousInteractionId?: string }
): Promise<{ interactionId: string }> {
  const url = `${GEMINI_API_BASE}/interactions`;
  const isFollowUp = !!opts?.previousInteractionId;

  const body: Record<string, unknown> = {
    input: prompt,
    background: true,
  };

  if (isFollowUp) {
    // Follow-ups use a model (not the deep-research agent) + link to parent
    body.model = FOLLOWUP_MODEL;
    body.previous_interaction_id = opts!.previousInteractionId;
  } else {
    // Initial research uses the deep-research agent
    body.agent = DEEP_RESEARCH_AGENT;
  }

  const resp = await axios.post(url, body, {
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.googleGeminiApiKey!,
    },
    timeout: 30_000,
  });

  const interactionId = resp.data?.id || resp.data?.name;
  if (!interactionId) {
    console.error('[Deep Research] Unexpected Gemini response:', JSON.stringify(resp.data));
    throw new Error('Gemini API did not return an interaction ID');
  }

  console.log(`[Deep Research] Interaction created: ${interactionId} (follow-up: ${isFollowUp})`);
  return { interactionId };
}

async function pollGeminiInteraction(interactionId: string): Promise<GeminiInteractionResponse> {
  const url = `${GEMINI_API_BASE}/interactions/${interactionId}`;

  const resp = await axios.get(url, {
    headers: { 'x-goog-api-key': config.googleGeminiApiKey! },
    timeout: 15_000,
  });

  return resp.data as GeminiInteractionResponse;
}

// ─── In-Memory Thinking Summary Buffer ───────────────────────────────

const summaryBuffers = new Map<string, {
  summaries: ThinkingSummary[];
  dirty: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
}>();

function getOrCreateBuffer(jobId: string) {
  let buf = summaryBuffers.get(jobId);
  if (!buf) {
    buf = { summaries: [], dirty: false, flushTimer: null };
    summaryBuffers.set(jobId, buf);
  }
  return buf;
}

function appendThinkingSummary(jobId: string, text: string) {
  const buf = getOrCreateBuffer(jobId);
  buf.summaries.push({
    text,
    timestamp: new Date().toISOString(),
    index: buf.summaries.length,
  });
  buf.dirty = true;

  // Debounced flush — write to DB at most every 3s
  if (!buf.flushTimer) {
    buf.flushTimer = setTimeout(() => flushSummaries(jobId), SUMMARY_FLUSH_INTERVAL_MS);
  }
}

async function flushSummaries(jobId: string) {
  const buf = summaryBuffers.get(jobId);
  if (!buf || !buf.dirty) return;

  buf.flushTimer = null;
  buf.dirty = false;

  try {
    await prisma.deepResearchJob.update({
      where: { id: jobId },
      data: { thinkingSummaries: JSON.stringify(buf.summaries) },
    });
  } catch (err) {
    // Put back dirty flag so next flush retries
    console.error(`[Deep Research] Failed to flush summaries for ${jobId}:`, err instanceof Error ? err.message : err);
    buf.dirty = true;
  }
}

async function finalFlushSummaries(jobId: string) {
  const buf = summaryBuffers.get(jobId);
  if (!buf) return;

  // Cancel pending debounce timer
  if (buf.flushTimer) {
    clearTimeout(buf.flushTimer);
    buf.flushTimer = null;
  }

  // Final write
  if (buf.dirty || buf.summaries.length > 0) {
    try {
      await prisma.deepResearchJob.update({
        where: { id: jobId },
        data: { thinkingSummaries: JSON.stringify(buf.summaries) },
      });
    } catch (err) {
      console.error(`[Deep Research] Final flush failed for ${jobId}:`, err instanceof Error ? err.message : err);
    }
  }

  // Cleanup
  summaryBuffers.delete(jobId);
}

// ─── SSE Stream Consumer ─────────────────────────────────────────────

async function consumeGeminiStream(
  jobId: string,
  prompt: string
): Promise<void> {
  const url = `${GEMINI_API_BASE}/interactions?alt=sse`;

  const body = {
    input: prompt,
    background: true,
    agent: DEEP_RESEARCH_AGENT,
    stream: true,
    agent_config: {
      type: 'deep-research',
      thinking_summaries: 'auto',
    },
  };

  const resp = await axios.post(url, body, {
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.googleGeminiApiKey!,
      Accept: 'text/event-stream',
    },
    responseType: 'stream',
    timeout: 90 * 60 * 1000, // 90 min — deep research can take a while
  });

  const stream = resp.data as NodeJS.ReadableStream;
  let interactionId: string | null = null;
  let accumulatedText = '';
  let sseBuffer = '';

  // Update job status
  await prisma.deepResearchJob.update({
    where: { id: jobId },
    data: { status: 'submitted', submittedAt: new Date(), modelUsed: DEEP_RESEARCH_AGENT },
  });

  return new Promise<void>((resolve, reject) => {
    let resolved = false;

    stream.on('data', (chunk: Buffer) => {
      if (resolved) return;
      sseBuffer += chunk.toString();

      // Process complete SSE events (double newline delimited)
      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop() || ''; // Keep incomplete event in buffer

      for (const rawEvent of events) {
        if (!rawEvent.trim() || resolved) continue;

        try {
          // Parse SSE format: "event: ...\ndata: ..."
          let dataStr = '';

          for (const line of rawEvent.split('\n')) {
            if (line.startsWith('data:')) {
              dataStr += line.slice(5).trim();
            }
          }

          if (!dataStr) continue;

          let data: Record<string, unknown>;
          try {
            data = JSON.parse(dataStr);
          } catch {
            continue; // Skip malformed JSON
          }

          // Route based on event_type from the JSON payload (Gemini Interactions API format)
          const eventType = data.event_type as string | undefined;

          // ── interaction.start — capture the interaction ID
          if (eventType === 'interaction.start') {
            const interaction = data.interaction as Record<string, unknown> | undefined;
            const id = interaction?.id as string | undefined;
            if (id && !interactionId) {
              interactionId = id;
              console.log(`[Deep Research] SSE interaction started: ${interactionId} for job ${jobId}`);
              prisma.deepResearchJob.update({
                where: { id: jobId },
                data: { geminiInteractionId: interactionId, status: 'in_progress' },
              }).catch(() => { /* best-effort */ });
            }
          }

          // ── content.delta — thinking summaries and text chunks
          if (eventType === 'content.delta') {
            const delta = data.delta as Record<string, unknown> | undefined;
            const deltaType = delta?.type as string | undefined;
            const deltaContent = delta?.content as Record<string, unknown> | undefined;
            const deltaText = deltaContent?.text as string | undefined;

            if (deltaType === 'thought_summary' || deltaType === 'thought') {
              // Thinking summary — show research progress to user
              const summaryText = deltaText || (delta?.summary as string | undefined);
              if (summaryText) {
                appendThinkingSummary(jobId, summaryText);
              }
            } else if (deltaType === 'text') {
              // Final output text — accumulate for JSON parsing
              if (deltaText) {
                accumulatedText += deltaText;
              }
            }
          }

          // ── interaction.complete — research finished (but outputs NOT included when streaming)
          if (eventType === 'interaction.complete') {
            const interaction = data.interaction as Record<string, unknown> | undefined;
            // Capture interaction ID if we missed it
            if (!interactionId && interaction?.id) {
              interactionId = interaction.id as string;
            }
            resolved = true;
            handleStreamCompletion(jobId, data, accumulatedText, interactionId)
              .then(resolve)
              .catch(reject);
            return;
          }

          // ── error — research failed
          if (eventType === 'error') {
            const errMsg = (data.message as string) || 'Gemini research failed';
            resolved = true;
            handleStreamFailure(jobId, errMsg, data)
              .then(resolve)
              .catch(reject);
            return;
          }

          // ── Fallback: check interaction.status for completion (in case event_type is missing)
          const interaction = data.interaction as Record<string, unknown> | undefined;
          const interactionStatus = interaction?.status as string | undefined;
          if (interactionStatus && ['completed', 'COMPLETE', 'complete'].includes(interactionStatus)) {
            if (!interactionId && interaction?.id) {
              interactionId = interaction.id as string;
            }
            resolved = true;
            handleStreamCompletion(jobId, data, accumulatedText, interactionId)
              .then(resolve)
              .catch(reject);
            return;
          }
          if (interactionStatus && ['failed', 'FAILED'].includes(interactionStatus)) {
            const errMsg = (data.message as string) || 'Gemini research failed';
            resolved = true;
            handleStreamFailure(jobId, errMsg, data)
              .then(resolve)
              .catch(reject);
            return;
          }
        } catch (err) {
          // Log but continue processing other events
          console.error(`[Deep Research] SSE parse error for job ${jobId}:`, err instanceof Error ? err.message : err);
        }
      }
    });

    stream.on('end', async () => {
      if (resolved) return;
      resolved = true;
      await finalFlushSummaries(jobId);

      // If we accumulated text from content.delta events, process it
      if (accumulatedText) {
        try {
          await handleStreamCompletion(jobId, {}, accumulatedText, interactionId);
          resolve();
        } catch (e) {
          reject(e);
        }
      } else if (interactionId) {
        // Stream ended without text — interaction.complete doesn't include outputs when streaming.
        // Save the interaction ID and let the poller fetch the full result.
        console.log(`[Deep Research] SSE stream ended for job ${jobId} without accumulated text — poller will fetch result via interaction ${interactionId}`);
        await prisma.deepResearchJob.update({
          where: { id: jobId },
          data: { geminiInteractionId: interactionId, status: 'in_progress' },
        }).catch(() => {});
        resolve();
      } else {
        console.log(`[Deep Research] SSE stream ended for job ${jobId} with no interaction ID — fallback will handle`);
        resolve();
      }
    });

    stream.on('error', async (err: Error) => {
      if (resolved) return;
      resolved = true;
      console.error(`[Deep Research] SSE stream error for job ${jobId}:`, err.message);
      await finalFlushSummaries(jobId);
      // Don't reject — let poller handle recovery if we have an interaction ID
      resolve();
    });
  });
}

async function handleStreamCompletion(
  jobId: string,
  data: Record<string, unknown>,
  accumulatedText: string,
  interactionId: string | null
): Promise<void> {
  await finalFlushSummaries(jobId);

  // When streaming, interaction.complete does NOT include outputs.
  // We must use text accumulated from content.delta events.
  // If that's empty and we have an interaction ID, poll the API to get the full result.
  let outputText = accumulatedText;

  if (!outputText && interactionId) {
    console.log(`[Deep Research] No accumulated text for job ${jobId} — polling interaction ${interactionId} for full result`);
    try {
      const fullResult = await pollGeminiInteraction(interactionId);
      const lastOutput = fullResult.outputs?.length ? fullResult.outputs[fullResult.outputs.length - 1] : null;
      outputText = lastOutput?.text || '';
      // Merge usage from polled result if the SSE completion event didn't have it
      if (!data.interaction && fullResult.usage) {
        data = { ...data, interaction: { usage: fullResult.usage } };
      }
    } catch (pollErr) {
      console.error(`[Deep Research] Failed to poll interaction for job ${jobId}:`, pollErr instanceof Error ? pollErr.message : pollErr);
    }
  }

  let resultJson: string | null = null;
  let resultText: string | null = null;
  let parseError: string | null = null;

  if (outputText) {
    try {
      const jsonStr = extractJson(outputText);
      JSON.parse(jsonStr); // Validate
      resultJson = jsonStr;
    } catch (e) {
      parseError = e instanceof Error ? e.message : 'JSON parse failed';
      resultText = outputText;
    }
  } else {
    parseError = 'No output text received from Gemini';
  }

  // Extract usage — Gemini SSE nests it under interaction.usage
  const interaction = data.interaction as Record<string, unknown> | undefined;
  const usage = (interaction?.usage || data.usage) as {
    total_input_tokens?: number;
    total_output_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  } | undefined;
  const inputTokens = usage?.total_input_tokens ?? usage?.input_tokens ?? null;
  const outputTokens = usage?.total_output_tokens ?? usage?.output_tokens ?? null;

  // If no usable output was produced, mark as failed instead of completed
  const hasUsableOutput = !!(resultJson || (resultText && resultText.trim().length > 0));
  await prisma.deepResearchJob.update({
    where: { id: jobId },
    data: {
      status: hasUsableOutput ? 'completed' : 'failed',
      geminiInteractionId: interactionId || undefined,
      resultJson,
      resultText: resultText || null,
      rawResultPayload: JSON.stringify(data),
      parseError: hasUsableOutput ? parseError : (parseError || 'No usable output from Gemini API'),
      errorMessage: hasUsableOutput ? undefined : 'Deep research produced no results — the API may have returned an empty response',
      inputTokens,
      outputTokens,
      costUsdEstimate: estimateCost(inputTokens, outputTokens, undefined),
      completedAt: new Date(),
      polledBy: null,
      leaseUntil: null,
    },
  });

  console.log(`[Deep Research] SSE stream completed for job ${jobId} (hasResult: ${!!resultJson}, hasText: ${!!resultText})`);
}

async function handleStreamFailure(
  jobId: string,
  errorMessage: string,
  data: Record<string, unknown>
): Promise<void> {
  await finalFlushSummaries(jobId);

  await prisma.deepResearchJob.update({
    where: { id: jobId },
    data: {
      status: 'failed',
      errorMessage,
      rawResultPayload: JSON.stringify(data),
      completedAt: new Date(),
      polledBy: null,
      leaseUntil: null,
    },
  });
}

// ─── Job Lifecycle ──────────────────────────────────────────────────

export async function startDeepResearch(
  userId: string,
  prompt: string,
  opts: { ticker?: string; researchType?: string; clientRequestId?: string }
): Promise<{ jobId: string; status: string }> {
  // Guard: feature flag
  if (!config.deepResearchEnabled) {
    throw new FeatureDisabledError();
  }

  // Guard: API key
  if (!config.googleGeminiApiKey) {
    throw new FeatureDisabledError();
  }

  // Guard: idempotency — if clientRequestId already exists, return existing job
  if (opts.clientRequestId) {
    const existing = await prisma.deepResearchJob.findUnique({
      where: {
        userId_clientRequestId: { userId, clientRequestId: opts.clientRequestId },
      },
    });
    if (existing) {
      return { jobId: existing.id, status: existing.status };
    }
  }

  // Guard: concurrent limit
  const activeCount = await prisma.deepResearchJob.count({
    where: {
      userId,
      status: { in: ['queued', 'submitted', 'in_progress'] },
    },
  });
  if (activeCount >= config.deepResearchMaxConcurrent) {
    throw new ConcurrentLimitError(config.deepResearchMaxConcurrent);
  }

  // Guard: monthly limit
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthlyUsed = await prisma.deepResearchJob.count({
    where: {
      userId,
      createdAt: { gte: monthStart },
      status: { notIn: ['failed'] },
    },
  });
  if (monthlyUsed >= config.deepResearchMonthlyLimit) {
    throw new MonthlyLimitError(config.deepResearchMonthlyLimit, monthlyUsed);
  }

  // Build full prompt with portfolio context
  const portfolioContext = await buildPortfolioContext(userId);
  const fullPrompt = buildDeepResearchPrompt(portfolioContext, prompt, {
    ticker: opts.ticker,
    researchType: opts.researchType,
  });

  // Create DB record
  const job = await prisma.deepResearchJob.create({
    data: {
      userId,
      ticker: opts.ticker,
      prompt,
      researchType: opts.researchType || 'stock',
      clientRequestId: opts.clientRequestId,
      status: 'queued',
    },
  });

  // Submit to Gemini — try SSE streaming first, fall back to non-streaming + poller
  try {
    // Fire-and-forget: SSE stream runs in background, updates DB as summaries arrive
    consumeGeminiStream(job.id, fullPrompt).catch(async (streamErr) => {
      console.error(`[Deep Research] SSE stream failed for job ${job.id}, falling back to poller:`, streamErr instanceof Error ? streamErr.message : streamErr);

      // Check if stream already updated the job (partial progress)
      const current = await prisma.deepResearchJob.findUnique({
        where: { id: job.id },
        select: { status: true, geminiInteractionId: true },
      });

      // If stream already got an interaction ID, poller can take over
      if (current?.geminiInteractionId) {
        console.log(`[Deep Research] Job ${job.id} has interaction ID — poller will continue`);
        return;
      }

      // Full fallback: create non-streaming interaction
      if (current?.status === 'queued' || current?.status === 'submitted') {
        try {
          const { interactionId } = await createGeminiInteraction(fullPrompt);
          await prisma.deepResearchJob.update({
            where: { id: job.id },
            data: {
              geminiInteractionId: interactionId,
              modelUsed: DEEP_RESEARCH_AGENT,
              status: 'submitted',
              submittedAt: new Date(),
            },
          });
          console.log(`[Deep Research] Fallback non-streaming interaction created for job ${job.id}`);
        } catch (fallbackErr) {
          const errMsg = fallbackErr instanceof Error ? fallbackErr.message : 'Submission failed';
          await prisma.deepResearchJob.update({
            where: { id: job.id },
            data: { status: 'failed', errorMessage: errMsg, completedAt: new Date() },
          });
        }
      }
    });

    return { jobId: job.id, status: 'submitted' };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown submission error';
    await prisma.deepResearchJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        errorMessage: errorMsg,
        completedAt: new Date(),
      },
    });
    throw err;
  }
}

export async function getJobStatus(
  jobId: string,
  userId: string
): Promise<{
  id: string;
  status: string;
  researchType: string;
  ticker: string | null;
  submittedAt: Date | null;
  completedAt: Date | null;
  pollCount: number;
  estimatedTimeRemainingMs: number | null;
  errorMessage: string | null;
  thinkingSummaries: ThinkingSummary[];
}> {
  const job = await prisma.deepResearchJob.findFirst({
    where: { id: jobId, userId },
    select: {
      id: true,
      status: true,
      researchType: true,
      ticker: true,
      submittedAt: true,
      completedAt: true,
      pollCount: true,
      errorMessage: true,
      thinkingSummaries: true,
    },
  });

  if (!job) {
    throw new Error('Job not found');
  }

  // Estimate remaining time based on poll count (15s intervals, ~20 min typical)
  let estimatedTimeRemainingMs: number | null = null;
  if (job.status === 'submitted' || job.status === 'in_progress') {
    const elapsedMs = job.pollCount * config.deepResearchPollIntervalMs;
    const typicalMs = 20 * 60 * 1000; // 20 minutes typical
    estimatedTimeRemainingMs = Math.max(0, typicalMs - elapsedMs);
  }

  // Parse thinking summaries from JSON string
  let thinkingSummaries: ThinkingSummary[] = [];
  if (job.thinkingSummaries) {
    try {
      thinkingSummaries = JSON.parse(job.thinkingSummaries) as ThinkingSummary[];
    } catch { /* return empty array on parse failure */ }
  }

  const { thinkingSummaries: _raw, ...rest } = job;
  return { ...rest, estimatedTimeRemainingMs, thinkingSummaries };
}

export async function getJobResult(
  jobId: string,
  userId: string
): Promise<{
  id: string;
  status: string;
  ticker: string | null;
  researchType: string;
  report: DeepResearchReport | null;
  resultText: string | null;
  parseError: string | null;
  costTelemetry: {
    inputTokens: number | null;
    outputTokens: number | null;
    searchCalls: number | null;
    costUsdEstimate: number | null;
    modelUsed: string | null;
  };
  completedAt: Date | null;
}> {
  const job = await prisma.deepResearchJob.findFirst({
    where: { id: jobId, userId },
    select: {
      id: true,
      status: true,
      ticker: true,
      researchType: true,
      resultJson: true,
      resultText: true,
      parseError: true,
      inputTokens: true,
      outputTokens: true,
      searchCalls: true,
      costUsdEstimate: true,
      modelUsed: true,
      completedAt: true,
    },
  });

  if (!job) {
    throw new Error('Job not found');
  }

  let report: DeepResearchReport | null = null;
  if (job.resultJson) {
    try {
      report = JSON.parse(job.resultJson) as DeepResearchReport;
    } catch { /* return null report, text fallback available */ }
  }

  return {
    id: job.id,
    status: job.status,
    ticker: job.ticker,
    researchType: job.researchType,
    report,
    resultText: job.resultText,
    parseError: job.parseError,
    costTelemetry: {
      inputTokens: job.inputTokens,
      outputTokens: job.outputTokens,
      searchCalls: job.searchCalls,
      costUsdEstimate: job.costUsdEstimate,
      modelUsed: job.modelUsed,
    },
    completedAt: job.completedAt,
  };
}

export async function submitFollowUp(
  parentJobId: string,
  userId: string,
  question: string
): Promise<{ jobId: string; status: string }> {
  // Guard: feature flag + API key
  if (!config.deepResearchEnabled || !config.googleGeminiApiKey) {
    throw new FeatureDisabledError();
  }

  // Verify parent job exists and belongs to user
  const parentJob = await prisma.deepResearchJob.findFirst({
    where: { id: parentJobId, userId },
    select: { id: true, geminiInteractionId: true, status: true },
  });

  if (!parentJob) {
    throw new Error('Parent job not found');
  }

  // Only allow follow-ups on completed jobs
  if (parentJob.status !== 'completed') {
    throw new Error('Can only follow up on completed research jobs');
  }

  if (!parentJob.geminiInteractionId) {
    throw new Error('Parent job has no interaction ID for follow-up');
  }

  // Concurrent + monthly guards
  const activeCount = await prisma.deepResearchJob.count({
    where: { userId, status: { in: ['queued', 'submitted', 'in_progress'] } },
  });
  if (activeCount >= config.deepResearchMaxConcurrent) {
    throw new ConcurrentLimitError(config.deepResearchMaxConcurrent);
  }

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthlyUsed = await prisma.deepResearchJob.count({
    where: { userId, createdAt: { gte: monthStart }, status: { notIn: ['failed'] } },
  });
  if (monthlyUsed >= config.deepResearchMonthlyLimit) {
    throw new MonthlyLimitError(config.deepResearchMonthlyLimit, monthlyUsed);
  }

  // Create follow-up job
  const job = await prisma.deepResearchJob.create({
    data: {
      userId,
      prompt: question,
      researchType: 'custom',
      parentInteractionId: parentJob.geminiInteractionId,
      status: 'queued',
    },
  });

  try {
    const { interactionId } = await createGeminiInteraction(question, {
      previousInteractionId: parentJob.geminiInteractionId,
    });
    await prisma.deepResearchJob.update({
      where: { id: job.id },
      data: {
        geminiInteractionId: interactionId,
        modelUsed: FOLLOWUP_MODEL,
        status: 'submitted',
        submittedAt: new Date(),
      },
    });
    return { jobId: job.id, status: 'submitted' };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown submission error';
    await prisma.deepResearchJob.update({
      where: { id: job.id },
      data: { status: 'failed', errorMessage: errorMsg, completedAt: new Date() },
    });
    throw err;
  }
}

export async function cancelJob(
  jobId: string,
  userId: string
): Promise<{ id: string; status: string }> {
  const job = await prisma.deepResearchJob.findFirst({
    where: { id: jobId, userId },
    select: { id: true, status: true },
  });

  if (!job) {
    throw new Error('Job not found');
  }

  // Only allow cancellation of active jobs
  if (!['queued', 'submitted', 'in_progress'].includes(job.status)) {
    throw new Error(`Cannot cancel job with status "${job.status}"`);
  }

  const updated = await prisma.deepResearchJob.update({
    where: { id: job.id },
    data: { status: 'cancelled', completedAt: new Date() },
    select: { id: true, status: true },
  });

  return updated;
}

export async function listUserJobs(
  userId: string,
  opts: { page?: number; limit?: number; status?: string }
): Promise<{
  jobs: Array<{
    id: string;
    ticker: string | null;
    prompt: string;
    researchType: string;
    status: string;
    createdAt: Date;
    completedAt: Date | null;
  }>;
  total: number;
  page: number;
  limit: number;
}> {
  const page = opts.page || 1;
  const limit = opts.limit || 20;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { userId };
  if (opts.status) where.status = opts.status;

  const [jobs, total] = await Promise.all([
    prisma.deepResearchJob.findMany({
      where,
      select: {
        id: true,
        ticker: true,
        prompt: true,
        researchType: true,
        status: true,
        createdAt: true,
        completedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.deepResearchJob.count({ where }),
  ]);

  return { jobs, total, page, limit };
}

// ─── Background Poller (with DB row locking) ────────────────────────

export async function pollActiveResearchJobs(): Promise<void> {
  if (!config.deepResearchEnabled || !config.googleGeminiApiKey) return;

  const now = new Date();

  // Find jobs that need polling: submitted/in_progress AND either no lease or expired lease
  const jobs = await prisma.deepResearchJob.findMany({
    where: {
      status: { in: ['submitted', 'in_progress'] },
      geminiInteractionId: { not: null },
      OR: [
        { leaseUntil: null },
        { leaseUntil: { lt: now } },
      ],
    },
    select: {
      id: true,
      geminiInteractionId: true,
      pollCount: true,
      status: true,
    },
  });

  for (const job of jobs) {
    if (!job.geminiInteractionId) continue;

    // Acquire lease — atomic update with condition check
    const leaseExpiry = new Date(Date.now() + LEASE_DURATION_MS);
    try {
      // Try to acquire lease. If another instance grabbed it first, this will
      // succeed but the job may have already been processed.
      const leaseResult = await prisma.deepResearchJob.updateMany({
        where: {
          id: job.id,
          OR: [
            { leaseUntil: null },
            { leaseUntil: { lt: now } },
          ],
        },
        data: {
          polledBy: INSTANCE_ID,
          leaseUntil: leaseExpiry,
        },
      });
      if (leaseResult.count === 0) continue; // Another instance acquired the lease
    } catch {
      continue; // Another instance acquired the lease
    }

    try {
      // Check if job has exceeded max poll count (timeout)
      if (job.pollCount >= MAX_POLL_COUNT) {
        await prisma.deepResearchJob.update({
          where: { id: job.id },
          data: {
            status: 'failed',
            errorMessage: `Research timed out after ${Math.round(job.pollCount * config.deepResearchPollIntervalMs / 60000)} minutes`,
            completedAt: new Date(),
            polledBy: null,
            leaseUntil: null,
          },
        });
        continue;
      }

      // Poll Gemini for status
      const result = await pollGeminiInteraction(job.geminiInteractionId);
      const newPollCount = job.pollCount + 1;

      if (result.status === 'completed' || result.status === 'COMPLETE' || result.status === 'complete') {
        // Extract output from Interactions API format: outputs[-1].text
        const rawPayload = JSON.stringify(result);
        const lastOutput = result.outputs?.length ? result.outputs[result.outputs.length - 1] : null;
        const outputText = lastOutput?.text || '';

        let resultJson: string | null = null;
        let resultText: string | null = null;
        let parseError: string | null = null;

        try {
          const jsonStr = extractJson(outputText);
          JSON.parse(jsonStr); // Validate it's valid JSON
          resultJson = jsonStr;
        } catch (e) {
          parseError = e instanceof Error ? e.message : 'JSON parse failed';
          resultText = outputText; // Store raw text as fallback
        }

        // If no usable output was produced, mark as failed instead of completed
        const hasOutput = !!(resultJson || (outputText && outputText.trim().length > 0));
        await prisma.deepResearchJob.update({
          where: { id: job.id },
          data: {
            status: hasOutput ? 'completed' : 'failed',
            resultJson,
            resultText: resultText || (resultJson ? null : outputText),
            rawResultPayload: rawPayload,
            parseError: hasOutput ? parseError : (parseError || 'No usable output from Gemini API'),
            errorMessage: hasOutput ? undefined : 'Deep research produced no results — the API may have returned an empty response',
            inputTokens: result.usage?.input_tokens ?? null,
            outputTokens: result.usage?.output_tokens ?? null,
            searchCalls: null, // Interactions API doesn't expose search count
            costUsdEstimate: estimateCost(
              result.usage?.input_tokens,
              result.usage?.output_tokens,
              undefined
            ),
            pollCount: newPollCount,
            completedAt: new Date(),
            polledBy: null,
            leaseUntil: null,
          },
        });
      } else if (result.status === 'failed' || result.status === 'FAILED' || result.error) {
        await prisma.deepResearchJob.update({
          where: { id: job.id },
          data: {
            status: 'failed',
            errorMessage: result.error?.message || 'Gemini research failed',
            rawResultPayload: JSON.stringify(result),
            pollCount: newPollCount,
            completedAt: new Date(),
            polledBy: null,
            leaseUntil: null,
          },
        });
      } else {
        // Still processing — update poll count, update status if needed, release lease
        const newStatus = (result.status === 'in_progress' || result.status === 'PROCESSING') ? 'in_progress' : job.status;
        await prisma.deepResearchJob.update({
          where: { id: job.id },
          data: {
            status: newStatus,
            pollCount: newPollCount,
            polledBy: null,
            leaseUntil: null,
          },
        });
      }
    } catch (err) {
      // Release lease on error so other instances can retry
      console.error(`[Deep Research] Poll error for job ${job.id}:`, err instanceof Error ? err.message : err);
      await prisma.deepResearchJob.update({
        where: { id: job.id },
        data: {
          pollCount: job.pollCount + 1,
          polledBy: null,
          leaseUntil: null,
        },
      }).catch(() => { /* swallow cleanup errors */ });
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function estimateCost(
  inputTokens?: number | null,
  outputTokens?: number | null,
  searchCalls?: number | null
): number | null {
  if (inputTokens == null && outputTokens == null) return null;
  // Rough estimate based on Gemini pricing: $0.0025/1K input, $0.01/1K output
  // Deep Research uses search calls which add cost
  const inputCost = ((inputTokens || 0) / 1000) * 0.0025;
  const outputCost = ((outputTokens || 0) / 1000) * 0.01;
  const searchCost = (searchCalls || 0) * 0.035; // ~$0.035 per search grounding call
  return Math.round((inputCost + outputCost + searchCost) * 100) / 100;
}
