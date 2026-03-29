/**
 * HTTP helpers for QuickChart.io (chart images via GET or POST /chart/create).
 */

import * as https from 'https';

export const CHART_VERSION = '4';
export const CHART_BG = '#ffffff';

/** Prefer POST when GET chart URL would exceed this length (GitHub Summary limits). */
export const QUICKCHART_URL_LIMIT = 1800;

export function postQuickChart(body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      'https://quickchart.io/chart/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { success: boolean; url: string };
            if (parsed.success && parsed.url) {
              resolve(parsed.url);
            } else {
              reject(new Error(`QuickChart API error: ${data}`));
            }
          } catch {
            reject(new Error(`QuickChart response parse error: ${data}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('QuickChart timeout')); });
    req.write(body);
    req.end();
  });
}

export function buildChartGetUrl(
  config: Record<string, unknown>,
  options?: { width?: number; height?: number; backgroundColor?: string },
): string {
  const w = options?.width ?? 1024;
  const h = options?.height ?? 250;
  const bg = options?.backgroundColor ?? CHART_BG;
  const json = JSON.stringify(config);
  const encoded = encodeURIComponent(json);
  const bkg = encodeURIComponent(bg);
  return `https://quickchart.io/chart?v=${CHART_VERSION}&c=${encoded}&w=${w}&h=${h}&bkg=${bkg}&f=png&devicePixelRatio=2`;
}
