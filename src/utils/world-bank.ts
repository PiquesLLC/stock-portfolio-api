/**
 * World Bank API v2 Client
 *
 * Free API, no key required. Used for international economic indicators
 * (EU + Japan) — GDP Growth, Inflation, Unemployment.
 */

export interface WorldBankDataPoint {
  country: string;
  countryCode: string;
  date: string;
  value: number;
}

interface WBResponseRecord {
  indicator: { id: string; value: string };
  country: { id: string; value: string };
  countryiso3code: string;
  date: string;
  value: number | null;
  unit: string;
  obs_status: string;
  decimal: number;
}

const WB_BASE_URL = 'https://api.worldbank.org/v2';

/**
 * Fetch a single indicator for a country from the World Bank API.
 * Returns data points sorted chronologically (oldest first).
 */
export async function fetchWorldBankIndicator(
  countryCode: string,
  indicatorCode: string,
  startYear: number = 2015,
  endYear: number = new Date().getFullYear(),
): Promise<WorldBankDataPoint[]> {
  const url = `${WB_BASE_URL}/country/${countryCode}/indicator/${indicatorCode}?format=json&per_page=50&date=${startYear}:${endYear}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`World Bank API error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();

  // WB API returns [metadata, data[]] — if no data, second element may be null
  if (!Array.isArray(json) || json.length < 2 || !Array.isArray(json[1])) {
    return [];
  }

  const records: WBResponseRecord[] = json[1];

  return records
    .filter(r => r.value != null)
    .map(r => ({
      country: r.country.value,
      countryCode: r.countryiso3code || countryCode,
      date: r.date,
      value: r.value!,
    }))
    .sort((a, b) => a.date.localeCompare(b.date)); // chronological
}
