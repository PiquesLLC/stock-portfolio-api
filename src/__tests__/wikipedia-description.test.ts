import { describe, it, expect, vi, beforeEach } from 'vitest';

// fetchWikipediaDescription does a DIRECT title lookup first (params.titles, redirects=1),
// then falls back to a full-text search (params.list='search'). Mock axios to drive both.
const axiosGetMock = vi.fn();
vi.mock('axios', () => ({
  default: { get: (...args: unknown[]) => axiosGetMock(...args) },
}));

import { fetchWikipediaDescription } from '../utils/yahoo-finance';

interface FakeWiki {
  pages?: Record<string, { extract: string; disambiguation?: boolean }>; // canonical title -> page
  redirects?: Record<string, string>; // requested title -> canonical title
  search?: string[]; // fallback full-text search result titles, in order
}

function mockWiki({ pages = {}, redirects = {}, search = [] }: FakeWiki) {
  axiosGetMock.mockImplementation((_url: string, opts: { params?: Record<string, unknown> }) => {
    const p = opts?.params || {};
    if (p.list === 'search') {
      return Promise.resolve({ data: { query: { search: search.map((title) => ({ title })) } } });
    }
    if (p.titles != null) {
      const requested = String(p.titles);
      const canonical = redirects[requested] ?? requested;
      const page = pages[canonical];
      if (!page) return Promise.resolve({ data: { query: { pages: { '-1': {} } } } });
      const pageObj: Record<string, unknown> = { title: canonical, extract: page.extract };
      if (page.disambiguation) pageObj.pageprops = { disambiguation: '' };
      return Promise.resolve({ data: { query: { pages: { '42': pageObj } } } });
    }
    return Promise.resolve({ data: {} });
  });
}

describe('fetchWikipediaDescription — resolves the listed company, not a subsidiary/concept/collision', () => {
  beforeEach(() => axiosGetMock.mockReset());

  it('TU / "Telus Corporation": direct lookup returns the parent article, NOT the "Telus Communications" subsidiary', async () => {
    mockWiki({
      pages: {
        'Telus Corporation': {
          extract:
            'Telus Corporation (also shortened to Telus Corp and stylized as TELUS) is a Canadian publicly traded holding company and conglomerate that operates in telecommunications. ',
        },
        // present + ranked #1 by full-text search, to prove direct-lookup wins and this is never used
        'Telus Communications': {
          extract: 'Telus Communications Inc. (TCI) is the wholly owned principal subsidiary of Telus Corporation. ',
        },
      },
      search: ['Telus Communications', 'Telus Corporation'],
    });
    const desc = await fetchWikipediaDescription('Telus Corporation');
    expect(desc).toContain('Telus Corporation');
    expect(desc).toContain('holding company');
    expect(desc).not.toContain('wholly owned principal subsidiary');
  });

  it('SHEL / "Shell plc": returns the company, NOT the generic "shell corporation" concept', async () => {
    mockWiki({
      pages: {
        'Shell plc': {
          extract: 'Shell plc is a British multinational oil and gas company headquartered in London, England. ',
        },
        'Shell corporation': {
          extract: 'A shell corporation (also known as a paper company) is a company with no significant assets or operations. ',
        },
      },
      search: ['Shell corporation'], // what the old full-text search resolved to
    });
    const desc = await fetchWikipediaDescription('Shell plc');
    expect(desc).toContain('Shell plc is a British multinational oil and gas company');
    expect(desc).not.toContain('no significant assets');
  });

  it('ORCL / "Oracle Corp": follows the redirect to "Oracle Corporation" (the Corp->Corporation regression)', async () => {
    mockWiki({
      redirects: { 'Oracle Corp': 'Oracle Corporation' },
      pages: {
        'Oracle Corporation': {
          extract: 'Oracle Corporation is an American multinational technology company headquartered in Austin, Texas. ',
        },
      },
    });
    const desc = await fetchWikipediaDescription('Oracle Corp');
    expect(desc).toContain('Oracle Corporation is an American multinational technology company');
  });

  it('returns null when only a named subsidiary exists (no parent article, via search fallback)', async () => {
    mockWiki({
      pages: { 'Telus Communications': { extract: 'Telus Communications Inc. is a subsidiary of Telus Corporation. ' } },
      search: ['Telus Communications'],
    });
    expect(await fetchWikipediaDescription('Telus Corporation')).toBeNull();
  });

  it('returns null on a more-prominent OTHER company (extract guard, e.g. ON -> TSMC)', async () => {
    mockWiki({
      pages: { TSMC: { extract: 'TSMC is a Taiwanese multinational semiconductor contract manufacturing company. ' } },
      search: ['TSMC'],
    });
    expect(await fetchWikipediaDescription('ON Semiconductor')).toBeNull();
  });

  it('fallback search: resolves a title-matching result when no exact direct page exists', async () => {
    mockWiki({
      pages: { 'Acme Corporation': { extract: 'Acme Corporation is a fictional company that appears in cartoons and films. ' } },
      search: ['Acme Corporation'],
    });
    const desc = await fetchWikipediaDescription('Acme Corp');
    expect(desc).toContain('Acme Corporation is a fictional company');
  });

  it('skips a disambiguation page rather than serving "X may refer to…"', async () => {
    mockWiki({
      pages: { Oracle: { extract: 'Oracle most commonly refers to a person who provides wise counsel or prophetic predictions. ', disambiguation: true } },
      search: [],
    });
    expect(await fetchWikipediaDescription('Oracle')).toBeNull();
  });
});
