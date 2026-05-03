import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import { resolvePolitician } from '../services/politician.service';

describe('politician resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prismaMock as any).politician = {
      findMany: vi.fn(),
    };
    (prismaMock as any).$queryRaw = vi.fn();
  });

  it('returns null when lastName is missing', async () => {
    const r = await resolvePolitician({ firstName: 'Mark', lastName: null });
    expect(r).toBeNull();
  });

  it('returns the bioguideId on a single chamber-scoped lastName match', async () => {
    (prismaMock as any).politician.findMany.mockResolvedValueOnce([
      { bioguideId: 'W000805', firstName: 'Mark', lastName: 'Warner', nameAliases: '[]', chamber: 'Senate' },
    ]);
    const r = await resolvePolitician({ firstName: 'Mark', lastName: 'Warner', chamber: 'Senate' });
    expect(r).toBe('W000805');
    // Only the chamber-scoped lookup runs.
    expect((prismaMock as any).politician.findMany).toHaveBeenCalledTimes(1);
  });

  it('falls back to lastName-only lookup when chamber filter returns nothing', async () => {
    (prismaMock as any).politician.findMany
      .mockResolvedValueOnce([]) // chamber-scoped: empty
      .mockResolvedValueOnce([
        { bioguideId: 'W000805', firstName: 'Mark', lastName: 'Warner', nameAliases: '[]' },
      ]);
    const r = await resolvePolitician({ firstName: 'Mark', lastName: 'Warner', chamber: 'House' });
    expect(r).toBe('W000805');
  });

  it('disambiguates same-lastName matches by firstName', async () => {
    (prismaMock as any).politician.findMany.mockResolvedValueOnce([
      { bioguideId: 'B001000', firstName: 'Sherrod', lastName: 'Brown', nameAliases: '[]' },
      { bioguideId: 'B002000', firstName: 'Anthony', lastName: 'Brown', nameAliases: '[]' },
    ]);
    const r = await resolvePolitician({ firstName: 'Sherrod', lastName: 'Brown' });
    expect(r).toBe('B001000');
  });

  it('matches nicknames via aliases (e.g. "Jim" → James Inhofe)', async () => {
    (prismaMock as any).politician.findMany.mockResolvedValueOnce([
      {
        bioguideId: 'I000024',
        firstName: 'James',
        lastName: 'Inhofe',
        nameAliases: JSON.stringify(['James Inhofe', 'Jim Inhofe']),
      },
      {
        bioguideId: 'X999999',
        firstName: 'Other',
        lastName: 'Inhofe',
        nameAliases: '["Other Inhofe"]',
      },
    ]);
    const r = await resolvePolitician({ firstName: 'Jim', lastName: 'Inhofe' });
    expect(r).toBe('I000024');
  });

  it('uses case-insensitive raw fallback when no exact lastName match', async () => {
    (prismaMock as any).politician.findMany
      .mockResolvedValueOnce([]) // chamber-scoped
      .mockResolvedValueOnce([]); // exact lastName
    (prismaMock as any).$queryRaw.mockResolvedValueOnce([
      { bioguideId: 'W000805', firstName: 'Mark' },
    ]);
    const r = await resolvePolitician({ firstName: 'Mark', lastName: 'WARNER', chamber: 'Senate' });
    expect(r).toBe('W000805');
  });

  it('returns null when ambiguous and no firstName provided', async () => {
    (prismaMock as any).politician.findMany.mockResolvedValueOnce([
      { bioguideId: 'B001000', firstName: 'Sherrod', lastName: 'Brown', nameAliases: '[]' },
      { bioguideId: 'B002000', firstName: 'Anthony', lastName: 'Brown', nameAliases: '[]' },
    ]);
    const r = await resolvePolitician({ lastName: 'Brown' });
    expect(r).toBeNull();
  });

  it('returns null when no match at any level', async () => {
    (prismaMock as any).politician.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    (prismaMock as any).$queryRaw.mockResolvedValueOnce([]);
    const r = await resolvePolitician({ firstName: 'Made', lastName: 'Up', chamber: 'Senate' });
    expect(r).toBeNull();
  });
});
