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
}

export interface BottlenecksResponse {
  sectors: string[];
  layers: string[];
  featured: Record<string, BottleneckEntry | null>;
  entries: BottleneckEntry[];
  generatedAt: string;
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
  // sit near the top while Compute remains the foundational anchor. Reviewed 2026-07-13:
  // ranking reaffirmed — grid-interconnect queues still exceed 2,100 GW (est. 30-50% of
  // 2026 AI capacity slipping to 2028; power still the binding build constraint), and
  // HBM demand is running ~70% YoY with 2026 capacity fully pre-allocated and memory now
  // ~30% of hyperscaler AI spend (memory intensifying but downstream of the power gate).
  // No structural shift → order unchanged.
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
  };

  responseCache.set(cacheKey, response);
  return response;
}
