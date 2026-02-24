import { getPortfolio } from './portfolio.service';
import { getPerformanceSummary } from './settings.service';
import { getPerformanceComparison, PerformanceWindow, PerformanceData } from './benchmark.service';
import { getPortfolioIntelligence } from './portfolioIntelligence.service';
import { getSnapshotChartPoints } from './snapshot.service';

// ─── Helpers ───────────────────────────────────────────────────────

function fmtCurrency(v: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(v);
}

function fmtCurrencyPrecise(v: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
}

function fmtPct(v: number | null): string {
  if (v == null) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function fmtDate(d: string | Date): string {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function color(v: number | null): string {
  if (v == null) return '#666';
  return v >= 0 ? '#00c805' : '#e8544e';
}

function periodToDays(period: PerformanceWindow): number {
  switch (period) {
    case '1D': return 1;
    case '1W': return 7;
    case '1M': return 30;
    case '3M': return 90;
    case 'YTD': return Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 1).getTime()) / 86400000);
    case '1Y': return 365;
    case 'ALL': return 3650;
  }
}

function periodLabel(period: PerformanceWindow): string {
  switch (period) {
    case '1D': return '1 Day';
    case '1W': return '1 Week';
    case '1M': return '1 Month';
    case '3M': return '3 Months';
    case 'YTD': return 'Year to Date';
    case '1Y': return '1 Year';
    case 'ALL': return 'All Time';
  }
}

// ─── SVG Sparkline ────────────────────────────────────────────────

function buildSparklineSvg(points: { time: number; value: number }[]): string {
  if (points.length < 2) return '';

  const W = 800;
  const H = 120;
  const PAD = 4;

  const minT = points[0].time;
  const maxT = points[points.length - 1].time;
  const values = points.map((p) => p.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const rangeV = maxV - minV || 1;
  const rangeT = maxT - minT || 1;

  const coords = points.map((p) => {
    const x = PAD + ((p.time - minT) / rangeT) * (W - 2 * PAD);
    const y = H - PAD - ((p.value - minV) / rangeV) * (H - 2 * PAD);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const isPositive = points[points.length - 1].value >= points[0].value;
  const strokeColor = isPositive ? '#00c805' : '#e8544e';

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;">
      <polyline
        points="${coords.join(' ')}"
        fill="none"
        stroke="${strokeColor}"
        stroke-width="2"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
    </svg>
  `;
}

// ─── Main Export ──────────────────────────────────────────────────

export async function generatePerformanceReport(
  userId: string,
  period: PerformanceWindow,
  benchmarkTicker: string,
  theme: 'light' | 'dark' = 'light',
): Promise<string> {
  // 4 parallel data fetches + sparkline
  const days = periodToDays(period);
  const intelligenceWindow = days <= 1 ? '1d' : days <= 7 ? '5d' : '1m';

  const [portfolio, summary, comparison, intelligence, chartPoints] = await Promise.all([
    getPortfolio(userId),
    getPerformanceSummary(userId),
    getPerformanceComparison(period, benchmarkTicker, userId).catch(() => null as PerformanceData | null),
    getPortfolioIntelligence(userId, intelligenceWindow).catch(() => null),
    getSnapshotChartPoints(userId, days).catch(() => [] as { time: number; value: number }[]),
  ]);

  const now = new Date();
  const reportDate = fmtDate(now);
  const sparkline = buildSparklineSvg(chartPoints);
  const { sinceTracking, holdingsPL } = summary;

  // Sort holdings by value descending
  const sortedHoldings = [...portfolio.holdings].sort((a, b) => b.currentValue - a.currentValue);
  const totalPortfolioValue = portfolio.totalAssets;

  const isDark = theme === 'dark';

  // Theme-aware colors
  const t = {
    bg:          isDark ? '#0a0a0a' : '#fff',
    text:        isDark ? '#e8e8e8' : '#111',
    muted:       isDark ? '#888' : '#666',
    subtle:      isDark ? '#666' : '#888',
    heading:     isDark ? '#ccc' : '#333',
    border:      isDark ? 'rgba(255,255,255,0.08)' : '#e5e5e5',
    borderLight: isDark ? 'rgba(255,255,255,0.06)' : '#f0f0f0',
    card:        isDark ? '#1a1a1e' : '#f9f9f9',
    sparklineBg: isDark ? '#1a1a1e' : '#fafafa',
    sectorTrack: isDark ? '#1a1a1e' : '#f0f0f0',
    printBg:     isDark ? '#0a0a0a' : '#fff',
  };

  // Build HTML
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nala - Portfolio Performance Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: ${t.text};
      background: ${t.bg};
      line-height: 1.5;
    }
    .container { max-width: 900px; margin: 0 auto; padding: 40px 24px; }
    .green { color: #00c805; }
    .red { color: #e8544e; }
    .muted { color: ${t.muted}; }

    /* Header */
    .header { text-align: center; margin-bottom: 36px; border-bottom: 2px solid #00c805; padding-bottom: 24px; }
    .header h1 { font-size: 28px; color: #00c805; margin-bottom: 4px; letter-spacing: -0.5px; }
    .header .subtitle { font-size: 14px; color: ${t.muted}; }
    .header .period-badge {
      display: inline-block; background: #00c805; color: #fff; font-size: 12px;
      font-weight: 600; padding: 3px 12px; border-radius: 12px; margin-top: 8px;
    }

    /* Stat boxes */
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .stat-box {
      border: 1px solid ${t.border}; border-radius: 10px; padding: 16px; text-align: center;
    }
    .stat-box .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: ${t.subtle}; margin-bottom: 4px; }
    .stat-box .value { font-size: 24px; font-weight: 700; }
    .stat-box .sub { font-size: 13px; margin-top: 2px; }

    /* Section */
    .section { margin-bottom: 32px; }
    .section h2 {
      font-size: 16px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
      color: ${t.heading}; border-bottom: 1px solid ${t.border}; padding-bottom: 8px; margin-bottom: 16px;
    }

    /* Table */
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    thead th {
      text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
      color: ${t.subtle}; padding: 8px 10px; border-bottom: 2px solid ${t.border};
    }
    thead th.right, td.right { text-align: right; }
    tbody td { padding: 10px 10px; border-bottom: 1px solid ${t.borderLight}; }
    tbody tr:last-child td { border-bottom: none; }

    /* Risk cards */
    .risk-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .risk-card {
      background: ${t.card}; border-radius: 8px; padding: 14px 16px;
    }
    .risk-card .risk-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: ${t.subtle}; }
    .risk-card .risk-value { font-size: 20px; font-weight: 700; margin-top: 2px; }

    /* Sector bars */
    .sector-row { display: flex; align-items: center; margin-bottom: 8px; }
    .sector-name { width: 140px; font-size: 13px; color: ${t.heading}; flex-shrink: 0; }
    .sector-bar-track { flex: 1; height: 20px; background: ${t.sectorTrack}; border-radius: 4px; overflow: hidden; margin: 0 10px; }
    .sector-bar-fill { height: 100%; background: #00c805; border-radius: 4px; transition: width 0.3s; }
    .sector-pct { width: 50px; text-align: right; font-size: 13px; font-weight: 600; color: ${t.heading}; }

    /* Movers */
    .movers-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .movers-list { }
    .movers-list h3 { font-size: 13px; font-weight: 700; margin-bottom: 8px; }
    .mover-item { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid ${t.borderLight}; font-size: 13px; }

    /* Footer */
    .footer {
      text-align: center; margin-top: 40px; padding-top: 20px; border-top: 1px solid ${t.border};
      font-size: 11px; color: ${t.subtle};
    }
    .footer .brand { color: #00c805; font-weight: 700; font-size: 13px; margin-top: 8px; }

    /* Print */
    @media print {
      body { background: ${t.printBg}; -webkit-print-color-adjust: exact; print-color-adjust: exact; color-adjust: exact; }
      .container { padding: 20px 0; }
      .stat-box, .risk-card { break-inside: avoid; }
      table { page-break-inside: auto; }
      tr { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
<div class="container">

  <!-- 1. Header -->
  <div class="header">
    <h1>Nala</h1>
    <div class="subtitle">Portfolio Performance Report &mdash; ${reportDate}</div>
    <div class="period-badge">${periodLabel(period)} &bull; vs ${benchmarkTicker}</div>
  </div>

  <!-- 2. Portfolio Snapshot -->
  <div class="section">
    <h2>Portfolio Snapshot</h2>
    <div class="stat-grid">
      <div class="stat-box">
        <div class="label">Net Equity</div>
        <div class="value">${fmtCurrency(portfolio.netEquity)}</div>
      </div>
      <div class="stat-box">
        <div class="label">Total Assets</div>
        <div class="value">${fmtCurrency(portfolio.totalAssets)}</div>
      </div>
      <div class="stat-box">
        <div class="label">Cash</div>
        <div class="value">${fmtCurrency(portfolio.cashBalance)}</div>
      </div>
      ${portfolio.marginDebt > 0 ? `
      <div class="stat-box">
        <div class="label">Margin Debt</div>
        <div class="value red">${fmtCurrency(portfolio.marginDebt)}</div>
      </div>` : ''}
    </div>
  </div>

  <!-- 3. Performance + Sparkline -->
  <div class="section">
    <h2>Performance</h2>
    <div class="stat-grid">
      ${sinceTracking.twrPercent != null ? `
      <div class="stat-box">
        <div class="label">TWR (Since Tracking)</div>
        <div class="value" style="color:${color(sinceTracking.twrPercent)}">${fmtPct(sinceTracking.twrPercent)}</div>
      </div>` : ''}
      ${sinceTracking.percentReturn != null ? `
      <div class="stat-box">
        <div class="label">Simple Return</div>
        <div class="value" style="color:${color(sinceTracking.percentReturn)}">${fmtPct(sinceTracking.percentReturn)}</div>
      </div>` : ''}
      <div class="stat-box">
        <div class="label">Unrealized P/L</div>
        <div class="value" style="color:${color(holdingsPL.unrealizedPL)}">${fmtCurrency(holdingsPL.unrealizedPL)}</div>
        <div class="sub" style="color:${color(holdingsPL.unrealizedPLPercent)}">${fmtPct(holdingsPL.unrealizedPLPercent)}</div>
      </div>
      <div class="stat-box">
        <div class="label">Day Change</div>
        <div class="value" style="color:${color(portfolio.dayChange)}">${fmtCurrency(portfolio.dayChange)}</div>
        <div class="sub" style="color:${color(portfolio.dayChangePercent)}">${fmtPct(portfolio.dayChangePercent)}</div>
      </div>
    </div>
    ${sparkline ? `
    <div style="margin-top: 8px; border: 1px solid ${t.borderLight}; border-radius: 8px; padding: 12px; background: ${t.sparklineBg};">
      ${sparkline}
      <div style="display:flex; justify-content:space-between; font-size:11px; color:${t.subtle}; margin-top:4px;">
        <span>${chartPoints.length > 0 ? fmtDate(new Date(chartPoints[0].time)) : ''}</span>
        <span>${chartPoints.length > 0 ? fmtDate(new Date(chartPoints[chartPoints.length - 1].time)) : ''}</span>
      </div>
    </div>` : ''}
  </div>

  <!-- 4. Benchmark Comparison -->
  ${comparison ? `
  <div class="section">
    <h2>Benchmark Comparison</h2>
    <table>
      <thead>
        <tr>
          <th></th>
          <th class="right">Your Portfolio</th>
          <th class="right">${benchmarkTicker}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Return (${periodLabel(period)})</td>
          <td class="right" style="font-weight:600; color:${color(comparison.simpleReturnPct)}">${fmtPct(comparison.simpleReturnPct)}</td>
          <td class="right" style="font-weight:600; color:${color(comparison.benchmarkReturnPct)}">${fmtPct(comparison.benchmarkReturnPct)}</td>
        </tr>
        <tr>
          <td>Alpha</td>
          <td class="right" style="font-weight:600; color:${color(comparison.alphaPct)}" colspan="2">${fmtPct(comparison.alphaPct)}</td>
        </tr>
        <tr>
          <td>Beta</td>
          <td class="right" colspan="2">${comparison.beta != null ? comparison.beta.toFixed(2) : '—'}</td>
        </tr>
        <tr>
          <td>Correlation</td>
          <td class="right" colspan="2">${comparison.correlation != null ? comparison.correlation.toFixed(2) : '—'}</td>
        </tr>
      </tbody>
    </table>
  </div>` : ''}

  <!-- 5. Risk Metrics -->
  ${comparison ? `
  <div class="section">
    <h2>Risk Metrics</h2>
    <div class="risk-grid">
      <div class="risk-card">
        <div class="risk-label">Max Drawdown</div>
        <div class="risk-value red">${comparison.maxDrawdownPct != null ? comparison.maxDrawdownPct.toFixed(2) + '%' : '—'}</div>
      </div>
      <div class="risk-card">
        <div class="risk-label">Volatility</div>
        <div class="risk-value">${comparison.volatilityPct != null ? comparison.volatilityPct.toFixed(2) + '%' : '—'}</div>
      </div>
      <div class="risk-card">
        <div class="risk-label">Best Day</div>
        <div class="risk-value green">${comparison.bestDay ? fmtPct(comparison.bestDay.returnPct) : '—'}</div>
        ${comparison.bestDay ? `<div style="font-size:11px; color:${t.subtle}; margin-top:2px;">${fmtDate(comparison.bestDay.date)}</div>` : ''}
      </div>
      <div class="risk-card">
        <div class="risk-label">Worst Day</div>
        <div class="risk-value red">${comparison.worstDay ? fmtPct(comparison.worstDay.returnPct) : '—'}</div>
        ${comparison.worstDay ? `<div style="font-size:11px; color:${t.subtle}; margin-top:2px;">${fmtDate(comparison.worstDay.date)}</div>` : ''}
      </div>
    </div>
  </div>` : ''}

  <!-- 6. Holdings Table -->
  <div class="section">
    <h2>Holdings (${sortedHoldings.length})</h2>
    ${sortedHoldings.length > 0 ? `
    <table>
      <thead>
        <tr>
          <th>Ticker</th>
          <th class="right">Shares</th>
          <th class="right">Avg Cost</th>
          <th class="right">Price</th>
          <th class="right">Value</th>
          <th class="right">P/L</th>
          <th class="right">Weight</th>
        </tr>
      </thead>
      <tbody>
        ${sortedHoldings.map((h) => `
        <tr>
          <td style="font-weight:600;">${h.ticker}</td>
          <td class="right">${h.shares.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
          <td class="right">${fmtCurrencyPrecise(h.averageCost)}</td>
          <td class="right">${fmtCurrencyPrecise(h.currentPrice)}</td>
          <td class="right">${fmtCurrency(h.currentValue)}</td>
          <td class="right" style="color:${color(h.profitLoss)}">
            ${fmtCurrency(h.profitLoss)}<br/>
            <span style="font-size:11px;">${fmtPct(h.profitLossPercent)}</span>
          </td>
          <td class="right">${totalPortfolioValue > 0 ? ((h.currentValue / totalPortfolioValue) * 100).toFixed(1) + '%' : '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : `
    <div style="text-align:center; padding:24px; color:${t.subtle};">
      No holdings in portfolio
    </div>`}
  </div>

  <!-- 7. Top Movers -->
  ${intelligence ? `
  <div class="section">
    <h2>Top Movers</h2>
    <div class="movers-grid">
      <div class="movers-list">
        <h3 class="green">&#9650; Top Gainers</h3>
        ${intelligence.contributors.length > 0
          ? intelligence.contributors.slice(0, 5).map((c) => `
          <div class="mover-item">
            <span style="font-weight:600;">${c.ticker}</span>
            <span style="color:#00c805; font-weight:600;">${fmtCurrency(c.contributionDollar)}</span>
          </div>`).join('')
          : `<div style="color:${t.subtle}; font-size:13px;">No gainers</div>`}
      </div>
      <div class="movers-list">
        <h3 class="red">&#9660; Top Losers</h3>
        ${intelligence.detractors.length > 0
          ? intelligence.detractors.slice(0, 5).map((d) => `
          <div class="mover-item">
            <span style="font-weight:600;">${d.ticker}</span>
            <span style="color:#e8544e; font-weight:600;">${fmtCurrency(d.contributionDollar)}</span>
          </div>`).join('')
          : `<div style="color:${t.subtle}; font-size:13px;">No losers</div>`}
      </div>
    </div>
  </div>` : ''}

  <!-- 8. Sector Allocation -->
  ${intelligence && intelligence.sectorExposure.length > 0 ? `
  <div class="section">
    <h2>Sector Allocation</h2>
    ${intelligence.sectorExposure
      .sort((a, b) => b.exposurePercent - a.exposurePercent)
      .map((s) => `
    <div class="sector-row">
      <div class="sector-name">${s.sector}</div>
      <div class="sector-bar-track">
        <div class="sector-bar-fill" style="width:${Math.min(s.exposurePercent, 100)}%"></div>
      </div>
      <div class="sector-pct">${s.exposurePercent.toFixed(1)}%</div>
    </div>`).join('')}
  </div>` : ''}

  <!-- 9. Footer -->
  <div class="footer">
    <div>This report is for informational purposes only and does not constitute financial advice.</div>
    <div style="margin-top:4px;">Report generated ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} at ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div>
    <div class="brand">Nala &mdash; Portfolio Tracking</div>
  </div>

</div>
</body>
</html>`;
}
