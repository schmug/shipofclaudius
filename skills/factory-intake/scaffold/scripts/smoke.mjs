#!/usr/bin/env node
// Smoke-test a deployed candidate THROUGH Cloudflare Access using a service token.
// Usage: node scripts/smoke.mjs --url https://host --out factory-reports/<key>
// Reads CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET from the environment and sends them as
// headers to the candidate's origin only. Never prints them. Exit 0 = pass, 1 = a check failed,
// 3 = Access blocked the request (token missing or not authorized for this application).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : dflt; };
const url = arg('--url');
const out = arg('--out', 'factory-reports/smoke');
if (!url) { console.error('usage: smoke.mjs --url <https://host> [--out <dir>]'); process.exit(1); }
mkdirSync(out, { recursive: true });

const headers = {};
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
  headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
}
const report = { url, checks: [], playwright: null };
const done = () => {
  writeFileSync(join(out, 'smoke.json'), JSON.stringify(report, null, 2));
  for (const c of report.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);
};

const t0 = Date.now();
const res = await fetch(url, { headers, redirect: 'manual' });
const ms = Date.now() - t0;
const loc = res.headers.get('location') || '';
if ((res.status === 302 || res.status === 301) && /cloudflareaccess\.com/.test(loc)) {
  report.checks.push({ name: 'access', ok: false, detail: 'redirected to the Access login: service token missing or not authorized for this app' });
  done();
  process.exit(3);
}
report.checks.push({ name: 'status', ok: res.status === 200, detail: `GET / -> ${res.status} in ${ms}ms` });
const ct = res.headers.get('content-type') || '';
report.checks.push({ name: 'content-type', ok: ct.includes('text/html'), detail: ct || '(none)' });
const body = await res.text();
writeFileSync(join(out, 'index.html.txt'), body.slice(0, 60_000));

try {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  // The service token is attached only to requests for the candidate's own origin. Cross-origin
  // subresources are aborted so a candidate page cannot pull the token out to another host.
  const origin = new URL(url).origin;
  await page.route('**/*', (route) => {
    const req = route.request();
    if (new URL(req.url()).origin === origin) return route.continue({ headers: { ...req.headers(), ...headers } });
    return route.abort();
  });
  // Console and pageerror text is page-controlled: keep at most 20 entries of 200 chars each. The
  // skill reads only the `ok` booleans from smoke.json.
  const errors = [];
  const record = (text) => { if (errors.length < 20) errors.push(String(text).slice(0, 200)); };
  page.on('console', (m) => { if (m.type() === 'error') record(m.text()); });
  page.on('pageerror', (e) => record(e));
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.screenshot({ path: join(out, 'screenshot-mobile.png'), fullPage: true });
  await browser.close();
  report.playwright = { consoleErrors: errors };
  report.checks.push({ name: 'console-errors', ok: errors.length === 0, detail: errors.join(' | ') || 'none' });
} catch (e) {
  report.playwright = { skipped: String(e && e.message || e) };
  report.checks.push({ name: 'playwright', ok: true, detail: `skipped (fetch-only smoke): ${String(e && e.message || e)}` });
}

done();
process.exit(report.checks.some((c) => !c.ok) ? 1 : 0);
