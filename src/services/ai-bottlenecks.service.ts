/**
 * AI Bottlenecks Service — serves a curated catalog of AI-supply-chain chokepoint stocks.
 *
 * Imports the static JSON catalog at module load (so tsc bundles it into dist/data/).
 * Returns a structured response with the featured entry separated and remaining
 * entries sorted by layer + name. No external API calls — pure data transform.
 */
import NodeCache from 'node-cache';
import catalogJson from '../data/ai-bottlenecks.json';

const responseCache = new NodeCache({ stdTTL: 300 });

export interface ChokepointMetric {
  label: string;
  value: string;
}

export interface BottleneckEntry {
  id: string;
  name: string;
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
  featured: BottleneckEntry | null;
  entries: BottleneckEntry[];
  layers: string[];
  generatedAt: string;
}

interface RawCatalog {
  generatedAt: string;
  entries: BottleneckEntry[];
}

/**
 * Display order for layers — used to sort the grid.
 * Layers not in this list get appended in alphabetical order.
 */
const LAYER_ORDER = [
  'Compute',
  'Lithography',
  'Memory',
  'Foundry',
  'Advanced Packaging',
  'Power & Cooling',
  'Networking',
  'Optical',
  'EDA',
  'Energy',
];

const catalog: RawCatalog = catalogJson as RawCatalog;

(function validateCatalog() {
  if (!catalog.entries || !Array.isArray(catalog.entries)) {
    throw new Error('[AI Bottlenecks] Invalid catalog: missing entries array');
  }
  const featuredCount = catalog.entries.filter(e => e.featured).length;
  if (featuredCount !== 1) {
    console.warn(
      `[AI Bottlenecks] Expected exactly 1 featured entry, found ${featuredCount}. Catalog still loaded.`,
    );
  }
})();

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

  const featured = catalog.entries.find(e => e.featured) || null;
  const nonFeatured = catalog.entries
    .filter(e => !e.featured)
    .sort((a, b) => {
      const layerCmp = compareLayers(a.layer, b.layer);
      if (layerCmp !== 0) return layerCmp;
      return a.name.localeCompare(b.name);
    });

  const presentLayers = Array.from(
    new Set(catalog.entries.map(e => e.layer)),
  ).sort(compareLayers);

  const response: BottlenecksResponse = {
    featured,
    entries: nonFeatured,
    layers: presentLayers,
    generatedAt: catalog.generatedAt,
  };

  responseCache.set(cacheKey, response);
  return response;
}
