import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Test that callGemini filters out "thought" parts from Gemini 2.5 responses.
 *
 * Gemini 2.5 Flash includes thinking/reasoning parts in the response alongside
 * the actual text parts. If we concatenate all parts, the thinking text gets
 * prepended to the JSON response, breaking JSON parsing downstream.
 */

// Mock axios before importing callGemini
vi.mock('axios');
vi.mock('../config', () => ({
  config: {
    googleGeminiApiKey: 'test-key',
  },
}));
vi.mock('../utils/prisma', () => ({
  default: {
    apiUsageLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

import axios from 'axios';
import { callGemini } from '../utils/gemini';
import { parsePerplexityJson } from '../utils/perplexity';

const mockedAxios = vi.mocked(axios);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('callGemini thought filtering', () => {
  it('should filter out thought parts and only return text content', async () => {
    // Simulate a Gemini 2.5 Flash response with thought parts
    const jsonResponse = '{"headline":"test","sections":[{"title":"Overview","takeaway":"Good","body":"Things look good","sentiment":"positive"}]}';

    mockedAxios.post.mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [
              // Thought part — internal reasoning, should be excluded
              { thought: true, text: 'Let me analyze this portfolio and construct a proper JSON response with the required fields...' },
              // Actual text response — this is what should be returned
              { text: `\`\`\`json\n${jsonResponse}\n\`\`\`` },
            ],
          },
        }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
        },
      },
    });

    const result = await callGemini(
      [
        { role: 'system', content: 'Return JSON only.' },
        { role: 'user', content: 'Test prompt' },
      ],
      { feature: 'test' },
    );

    expect(result).not.toBeNull();
    // The content should NOT contain the thinking text
    expect(result!.content).not.toContain('Let me analyze');
    // The content should be parseable as JSON after stripping markdown fences
    const parsed = parsePerplexityJson(result!.content);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect((parsed.data as any).headline).toBe('test');
    }
  });

  it('should handle responses with only text parts (no thought parts)', async () => {
    const jsonResponse = '{"headline":"test"}';

    mockedAxios.post.mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [
              { text: jsonResponse },
            ],
          },
        }],
        usageMetadata: {
          promptTokenCount: 50,
          candidatesTokenCount: 20,
        },
      },
    });

    const result = await callGemini(
      [{ role: 'user', content: 'Test' }],
      { feature: 'test' },
    );

    expect(result).not.toBeNull();
    expect(result!.content).toBe(jsonResponse);
  });

  it('should handle responses where all parts are thought parts', async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [
              { thought: true, text: 'Thinking about this...' },
            ],
          },
        }],
        usageMetadata: {
          promptTokenCount: 50,
          candidatesTokenCount: 20,
        },
      },
    });

    const result = await callGemini(
      [{ role: 'user', content: 'Test' }],
      { feature: 'test' },
    );

    expect(result).not.toBeNull();
    // If all parts are thought parts, content should be empty
    expect(result!.content).toBe('');
  });

  it('should concatenate multiple non-thought text parts', async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [
              { thought: true, text: 'Internal reasoning...' },
              { text: '{"headline":' },
              { text: '"test"}' },
            ],
          },
        }],
        usageMetadata: {
          promptTokenCount: 50,
          candidatesTokenCount: 20,
        },
      },
    });

    const result = await callGemini(
      [{ role: 'user', content: 'Test' }],
      { feature: 'test' },
    );

    expect(result).not.toBeNull();
    expect(result!.content).toBe('{"headline":"test"}');
    expect(result!.content).not.toContain('Internal reasoning');
  });
});
