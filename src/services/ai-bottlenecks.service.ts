/**
 * Bottlenecks Service — serves a curated catalog of supply-chain chokepoint stocks
 * across multiple sectors (AI, Healthcare, Defense, Energy).
 *
 * Imports all sector JSON catalogs at module load (so tsc bundles them into dist/data/).
 * Returns a structured response with per-sector featured entries, all non-featured
 * entries flattened with a `sector` field, and the display-sorted sector + layer indexes.
 */
import NodeCache from 'node-cache';
import aiCatalog from '../data/ai-bottlenecks.json';
import healthcareCatalog from '../data/healthcare-bottlenecks.json';
import defenseCatalog from '../data/defense-bottlenecks.json';
import energyCatalog from '../data/energy-bottlenecks.json';

const responseCache = new NodeCache({ stdTTL: 300 });

export interface ChokepointMetric {
  label: string;
  value: string;
}

export interface BottleneckEntry {
  id: string;
  name: string;
  sector: string;
  layer: string;
  primaryTicker: string;
  relatedTickers: string[];
  thesisShort: string;
  thesisLong: string;
  chokepointMetrics: ChokepointMetric[];
  catalysts: string[];
  risks: string[];
  featured: boolean;
  lastUpdated: string;
  /** Attached at read time from BottleneckMomentum. Absent until the weekly job has run. */
  momentum?: EntryMomentum;
}

/**
 * Weekly ranking signal attached to an entry. `momentum` is benchmark-relative
 * price strength, NOT a judgement of value — see the framing note on
 * buildMomentumResponse() before surfacing any of this in copy.
 */
export interface EntryMomentum {
  /** 0-100 blended Pressure Score (editorial anchor + market momentum). */
  score: number;
  /** -1..1 benchmark-relative strength, clamped. */
  momentum: number;
  /** Rank within the sector for the scored week, 1 = highest score. */
  rank: number;
  /**
   * Movement vs `prevIsoWeek`, measured over entries present in both weeks so
   * catalog churn doesn't read as movement. Positive = moved up. Null if new.
   */
  rankDelta: number | null;
  /** ISO week the score belongs to, e.g. "2026-W34". */
  isoWeek: string;
  /**
   * The week `rankDelta` compares against — NOT necessarily the immediately
   * preceding one, since the job diffs against the most recent SCORED week.
   * Copy must not say "last week" when this isn't the prior week.
   */
  prevIsoWeek: string | null;
  /**
   * Tickers that actually resolved and contributed to `momentum`. Copy making
   * factual claims about price behaviour must name THESE, not the entry's full
   * ticker list — some of those may have been skipped.
   */
  tickersUsed: string[];
}

/** A notable weekly mover, surfaced in the "Moving this week" strip. */
export interface BottleneckMover {
  id: string;
  name: string;
  sector: string;
  layer: string;
  primaryTicker: string;
  rank: number;
  rankDelta: number;
}

export interface BottlenecksResponse {
  sectors: string[];
  layers: string[];
  featured: Record<string, BottleneckEntry | null>;
  entries: BottleneckEntry[];
  generatedAt: string;
  /** Biggest sector-wide rank movers this week, keyed by sector. Empty until the job runs. */
  movers: Record<string, BottleneckMover[]>;
  /** ISO week the attached momentum belongs to, or null if none is available. */
  momentumWeek: string | null;
}

interface RawCatalog {
  generatedAt: string;
  entries: BottleneckEntry[];
}

/**
 * Display order for sectors — used to sort the outer sector tabs.
 */
const SECTOR_ORDER = ['AI', 'Healthcare', 'Defense', 'Energy'];

/**
 * Display order for layers — used to sort the grid within each sector.
 * Layers not in this list get appended in alphabetical order.
 */
const LAYER_ORDER = [
  // AI layers — ranked by current market relevance. 2026 has shifted the binding
  // constraint toward power (grid interconnect, transformer/switchgear/gas-turbine
  // lead times) with HBM/DRAM in acute shortage, so the power complex and memory
  // sit near the top while Compute remains the foundational anchor. Reviewed 2026-07-20:
  // ranking reaffirmed — grid-interconnect queues still exceed 2,100 GW (est. 30-50% of
  // 2026 AI capacity slipping to 2028; power still the binding build constraint), and
  // HBM is fully pre-allocated for 2026 (~300% of DDR5 wafer intensity, memory now ~30%
  // of hyperscaler AI spend vs ~8% in 2023-24) — intensifying but still downstream of the
  // power gate. No structural shift → order unchanged.
  'Compute',
  'Power & Cooling',
  'Memory',
  'Energy',
  'Lithography',
  'Foundry',
  'Advanced Packaging',
  'Networking',
  'Optical',
  'EDA',
  // Healthcare layers
  'GLP-1 & Obesity',
  'CDMO / Bio Manufacturing',
  'Gene & Cell Therapy',
  'Oncology Pipeline',
  'Diagnostics & Imaging',
  'Medical Devices Surgery',
  'Generics & Compounding',
  'Plasma / Blood Products',
  'Animal Health',
  'Hospital REITs / Operators',
  // Defense layers
  'Munitions',
  'Shipyards',
  'Aerospace & Engines',
  'Space Launch',
  'Rare Earths & Critical Minerals',
  'Cyber & Defense Software',
  'Satellites & ISR',
  'Drones & Autonomous Systems',
  'Specialty Metals',
  // Energy layers
  'LNG Export',
  'Refining',
  'Midstream / Pipelines',
  'Oilfield Services',
  'E&P Premium Basins',
  'Uranium Fuel Cycle',
  'Solar Manufacturing',
  'Inverters / Power Electronics',
  'Coal',
  'Grid Transmission & Equipment',
];

const SECTOR_CATALOGS: Record<string, RawCatalog> = {
  AI: aiCatalog as RawCatalog,
  Healthcare: healthcareCatalog as RawCatalog,
  Defense: defenseCatalog as RawCatalog,
  Energy: energyCatalog as RawCatalog,
};

(function validateCatalogs() {
  for (const [sectorName, catalog] of Object.entries(SECTOR_CATALOGS)) {
    if (!catalog.entries || !Array.isArray(catalog.entries)) {
      console.warn(`[Bottlenecks] ${sectorName} catalog missing entries array — treating as empty.`);
      continue;
    }
    const featuredCount = catalog.entries.filter(e => e.featured).length;
    if (catalog.entries.length > 0 && featuredCount !== 1) {
      console.warn(
        `[Bottlenecks] ${sectorName} has ${catalog.entries.length} entries but ${featuredCount} featured (expected 1).`,
      );
    }
  }
})();

function compareSectors(a: string, b: string): number {
  const ai = SECTOR_ORDER.indexOf(a);
  const bi = SECTOR_ORDER.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

function compareLayers(a: string, b: string): number {
  const ai = LAYER_ORDER.indexOf(a);
  const bi = LAYER_ORDER.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

/**
 * Every catalog entry across all sectors, featured included, in catalog order.
 * Used by the weekly momentum job, which scores entries independently of how
 * they happen to be displayed.
 */
export function getCatalogEntries(): BottleneckEntry[] {
  const all: BottleneckEntry[] = [];
  for (const catalog of Object.values(SECTOR_CATALOGS)) {
    if (!catalog.entries) continue;
    all.push(...catalog.entries);
  }
  return all;
}

/** Distinct layers present in a sector, in editorial (LAYER_ORDER) order. */
export function getSectorLayers(sector: string): string[] {
  const catalog = SECTOR_CATALOGS[sector];
  if (!catalog?.entries) return [];
  return Array.from(new Set(catalog.entries.map(e => e.layer))).sort(compareLayers);
}

/**
 * The editorial half of the Pressure Score: how binding this layer is judged to
 * be within its sector, from its position in LAYER_ORDER. Top layer = 1, bottom
 * = 0. This is the deliberately slow-moving anchor — momentum supplies the
 * week-to-week movement, but cannot bury a structurally critical chokepoint
 * just because it traded flat for a month.
 */
export function getEditorialAnchor(sector: string, layer: string): number {
  const layers = getSectorLayers(sector);
  // Unknown sector (no catalog) yields no layers. Fail CLOSED — returning the
  // max anchor here would hand an unrecognised entry the highest editorial
  // weight in the blend. The catalogs are edited weekly by an autonomous
  // routine, so a sector key drifting out of sync is a live possibility.
  if (layers.length === 0) return 0;
  if (layers.length === 1) return 1;
  const idx = layers.indexOf(layer);
  if (idx === -1) return 0;
  return 1 - idx / (layers.length - 1);
}

export function getBottlenecksData(): BottlenecksResponse {
  const cacheKey = 'bottlenecks-response';
  const cached = responseCache.get<BottlenecksResponse>(cacheKey);
  if (cached) return cached;

  const featured: Record<string, BottleneckEntry | null> = {};
  const allNonFeatured: BottleneckEntry[] = [];
  const presentSectors: string[] = [];
  const allLayers = new Set<string>();
  let latestGeneratedAt = '';

  for (const [sectorName, catalog] of Object.entries(SECTOR_CATALOGS)) {
    if (!catalog.entries || catalog.entries.length === 0) continue;
    presentSectors.push(sectorName);

    // Pick the explicit featured entry; if none, auto-promote the first entry
    // so every populated sector renders a hero card.
    let sectorFeatured = catalog.entries.find(e => e.featured) || null;
    let nonFeatured: BottleneckEntry[];
    if (sectorFeatured) {
      nonFeatured = catalog.entries.filter(e => !e.featured);
    } else {
      sectorFeatured = { ...catalog.entries[0], featured: true };
      nonFeatured = catalog.entries.slice(1);
    }
    featured[sectorName] = sectorFeatured;
    allNonFeatured.push(...nonFeatured);

    for (const e of catalog.entries) {
      allLayers.add(e.layer);
    }

    if (catalog.generatedAt > latestGeneratedAt) {
      latestGeneratedAt = catalog.generatedAt;
    }
  }

  const sortedNonFeatured = allNonFeatured.sort((a, b) => {
    const sectorCmp = compareSectors(a.sector, b.sector);
    if (sectorCmp !== 0) return sectorCmp;
    const layerCmp = compareLayers(a.layer, b.layer);
    if (layerCmp !== 0) return layerCmp;
    return a.name.localeCompare(b.name);
  });

  const sortedSectors = presentSectors.sort(compareSectors);
  const sortedLayers = Array.from(allLayers).sort(compareLayers);

  const response: BottlenecksResponse = {
    sectors: sortedSectors,
    layers: sortedLayers,
    featured,
    entries: sortedNonFeatured,
    generatedAt: latestGeneratedAt,
    movers: {},
    momentumWeek: null,
  };

  responseCache.set(cacheKey, response);
  return response;
}

/**
 * Re-sort a catalog response against a week of momentum scores and attach the
 * "Moving this week" movers.
 *
 * Ordering contract — this is the part that matters editorially:
 *   layer position stays EDITORIAL (LAYER_ORDER is untouched); momentum only
 *   reorders entries WITHIN a layer. A hot month can move a company up its own
 *   chokepoint, but cannot promote a chokepoint above one judged more binding.
 *
 * The displayed rank delta is the entry's SECTOR-wide rank change, not its
 * within-layer change — layers hold only 2-4 entries, so within-layer movement
 * is almost always +/-1 and reads as noise.
 *
 * Framing: `momentum` is benchmark-relative price movement. Copy built on it
 * must describe ACTIVITY ("moving this week"), never merit ("strongest",
 * "leaders", "top picks") — the latter reads as a recommendation and is barred
 * by the same no-advice rule the weekly editorial routine enforces.
 */
export function buildMomentumResponse(
  base: BottlenecksResponse,
  scores: Map<string, EntryMomentum>,
  moversPerSector = 4,
): BottlenecksResponse {
  if (scores.size === 0) return base;

  const attach = (e: BottleneckEntry): BottleneckEntry => {
    const m = scores.get(e.id);
    return m ? { ...e, momentum: m } : e;
  };

  const featured: Record<string, BottleneckEntry | null> = {};
  for (const [sector, entry] of Object.entries(base.featured)) {
    featured[sector] = entry ? attach(entry) : null;
  }

  const entries = base.entries.map(attach).sort((a, b) => {
    const sectorCmp = compareSectors(a.sector, b.sector);
    if (sectorCmp !== 0) return sectorCmp;
    const layerCmp = compareLayers(a.layer, b.layer);
    if (layerCmp !== 0) return layerCmp;
    // Within a layer: higher Pressure Score first. Unscored entries sink to the
    // bottom of their layer rather than jumping the queue on a default of 0.
    const as = a.momentum?.score;
    const bs = b.momentum?.score;
    if (as == null && bs == null) return a.name.localeCompare(b.name);
    if (as == null) return 1;
    if (bs == null) return -1;
    if (bs !== as) return bs - as;
    return a.name.localeCompare(b.name);
  });

  // Movers are drawn from featured + non-featured alike: the hero moving is
  // itself news. Only entries that actually moved qualify.
  const movers: Record<string, BottleneckMover[]> = {};
  const candidates = [...Object.values(featured).filter((e): e is BottleneckEntry => e !== null), ...entries];
  for (const sector of base.sectors) {
    movers[sector] = candidates
      .filter(e => e.sector === sector && e.momentum && e.momentum.rankDelta != null && e.momentum.rankDelta !== 0)
      .sort((a, b) => Math.abs(b.momentum!.rankDelta!) - Math.abs(a.momentum!.rankDelta!))
      .slice(0, moversPerSector)
      .map(e => ({
        id: e.id,
        name: e.name,
        sector: e.sector,
        layer: e.layer,
        primaryTicker: e.primaryTicker,
        rank: e.momentum!.rank,
        rankDelta: e.momentum!.rankDelta!,
      }));
  }

  const isoWeek = scores.values().next().value?.isoWeek ?? null;

  return { ...base, featured, entries, movers, momentumWeek: isoWeek };
}
