import prisma from '../utils/prisma';

// Open community-maintained roster of every current US Congress member,
// updated daily by volunteers and used as the source of truth by GovTrack,
// ProPublica, Capitol Trades, etc. We mirror it locally so we can resolve
// FMP's free-form politician strings ("Mark Warner") to a stable Bioguide
// ID ("W000805") which deep-links into Capitol Trades / Congress.gov.
const LEGISLATORS_URL =
  'https://unitedstates.github.io/congress-legislators/legislators-current.json';

interface LegislatorTerm {
  type: 'sen' | 'rep';
  party?: string;
  state?: string;
  end?: string;
}

interface LegislatorRecord {
  id?: { bioguide?: string };
  name?: {
    first?: string;
    last?: string;
    official_full?: string;
    nickname?: string;
  };
  terms?: LegislatorTerm[];
}

export interface ResolvePoliticianOpts {
  firstName?: string | null;
  lastName?: string | null;
  chamber?: 'Senate' | 'House';
}

/**
 * Pull the legislators-current.json roster from the unitedstates/congress-legislators
 * GitHub repo and upsert every member into the Politician table. Safe to run on a
 * weekly cron — the upsert is idempotent.
 */
export async function refreshPoliticianRoster(): Promise<{ processed: number; errors: number }> {
  const res = await fetch(LEGISLATORS_URL);
  if (!res.ok) {
    throw new Error(`legislators fetch failed: HTTP ${res.status}`);
  }
  const records = (await res.json()) as LegislatorRecord[];

  let processed = 0;
  let errors = 0;

  for (const r of records) {
    try {
      const bioguideId = r.id?.bioguide;
      if (!bioguideId) continue;

      const firstName = r.name?.first ?? null;
      const lastName = r.name?.last ?? null;
      if (!lastName) continue;

      const officialFull = r.name?.official_full || `${firstName ?? ''} ${lastName}`.trim();

      // Most recent term wins (members can switch chambers — Pence was rep then VP).
      const lastTerm = r.terms?.[r.terms.length - 1];
      const chamber =
        lastTerm?.type === 'sen' ? 'Senate' : lastTerm?.type === 'rep' ? 'House' : null;
      const party = lastTerm?.party ?? null;
      const state = lastTerm?.state ?? null;

      // Aliases let the resolver match name variants FMP might emit.
      const aliases = new Set<string>();
      aliases.add(`${firstName} ${lastName}`.trim());
      if (r.name?.nickname) aliases.add(`${r.name.nickname} ${lastName}`.trim());
      if (officialFull) aliases.add(officialFull);

      await prisma.politician.upsert({
        where: { bioguideId },
        update: {
          canonicalName: officialFull,
          firstName,
          lastName,
          chamber,
          party,
          state,
          nameAliases: JSON.stringify(Array.from(aliases)),
          refreshedAt: new Date(),
        },
        create: {
          bioguideId,
          canonicalName: officialFull,
          firstName,
          lastName,
          chamber,
          party,
          state,
          nameAliases: JSON.stringify(Array.from(aliases)),
        },
      });
      processed++;
    } catch {
      errors++;
    }
  }

  return { processed, errors };
}

/**
 * Resolve a (firstName, lastName, chamber) tuple from FMP to a Bioguide ID.
 * Returns null when no confident match — the trade still ingests, the UI
 * just falls back to a non-clickable label until the next roster refresh.
 *
 * Strategy:
 *   1. Exact lastName + chamber → if exactly one match, return it.
 *   2. Exact lastName only → if exactly one match, return it.
 *   3. Multiple lastName matches → disambiguate by firstName (case-insensitive).
 *   4. No exact lastName match → case-insensitive raw query as fallback.
 *   5. Still nothing → null.
 */
export async function resolvePolitician(opts: ResolvePoliticianOpts): Promise<string | null> {
  const lastName = opts.lastName?.trim();
  if (!lastName) return null;

  const firstName = opts.firstName?.trim() ?? null;
  const chamber = opts.chamber;

  // Step 1: lastName + chamber filter (tightest)
  if (chamber) {
    const scoped = await prisma.politician.findMany({ where: { lastName, chamber } });
    if (scoped.length === 1) return scoped[0].bioguideId;
    if (scoped.length > 1 && firstName) {
      const match = pickByFirstName(scoped, firstName);
      if (match) return match;
    }
  }

  // Step 2: exact lastName only
  const byLast = await prisma.politician.findMany({ where: { lastName } });
  if (byLast.length === 1) return byLast[0].bioguideId;
  if (byLast.length > 1 && firstName) {
    const match = pickByFirstName(byLast, firstName);
    if (match) return match;
  }

  // Step 3: case-insensitive lastName fallback (covers "WARNER", "warner")
  if (byLast.length === 0) {
    const ci = await prisma.$queryRaw<Array<{ bioguideId: string; firstName: string | null }>>`
      SELECT bioguideId, firstName FROM Politician
      WHERE LOWER(lastName) = LOWER(${lastName})
      LIMIT 10
    `;
    if (ci.length === 1) return ci[0].bioguideId;
    if (ci.length > 1 && firstName) {
      const fn = firstName.toLowerCase();
      const match = ci.find((c) => c.firstName?.toLowerCase() === fn);
      if (match) return match.bioguideId;
    }
  }

  return null;
}

function pickByFirstName(
  candidates: Array<{ bioguideId: string; firstName: string | null; nameAliases: string }>,
  firstName: string,
): string | null {
  const fn = firstName.toLowerCase();
  // Try exact firstName field match first.
  const exact = candidates.find((c) => c.firstName?.toLowerCase() === fn);
  if (exact) return exact.bioguideId;

  // Then try aliases (covers "Jim" vs "James", "Bob" vs "Robert").
  for (const c of candidates) {
    try {
      const aliases: string[] = JSON.parse(c.nameAliases);
      if (aliases.some((a) => a.toLowerCase().startsWith(`${fn} `))) return c.bioguideId;
    } catch {
      // malformed alias JSON — skip
    }
  }
  return null;
}
