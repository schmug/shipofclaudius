// Visual capture: per-route before/after screenshots and a pixel diff, via Playwright.
//
// Playwright is OPTIONAL and never a dependency of this repo. It is resolved at runtime
// from the reviewed repo, then from the global npm root; when it is missing, or no URLs
// were given, the Visual tab renders a "skipped" state with the reason. The pixel diff is
// computed inside the same headless browser (two images drawn to canvases), so no PNG
// library is needed either.

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } }

async function loadPlaywright(cwd) {
  const roots = [cwd]
  try { roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) } catch {}
  for (const r of roots) {
    try {
      const req = createRequire(join(r, 'noop.js'))
      const p = req.resolve('playwright', { paths: [r] })
      const mod = await import(pathToFileURL(p).href)
      return mod.chromium ? mod : mod.default
    } catch {}
  }
  return null
}

export const joinUrl = (baseUrl, route) => {
  const u = new URL(baseUrl)
  const r = route.startsWith('/') ? route : `/${route}`
  u.pathname = (u.pathname.replace(/\/$/, '') + r).replace(/\/{2,}/g, '/')
  return u.toString()
}

const DIFF_FN = `async ([a, b]) => {
  const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src })
  const [ia, ib] = await Promise.all([load(a), load(b)])
  const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height)
  const ctx = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0); return x }
  const da = ctx(ia).getImageData(0, 0, w, h).data, db = ctx(ib).getImageData(0, 0, w, h).data
  const out = document.createElement('canvas'); out.width = w; out.height = h
  const ox = out.getContext('2d'); const od = ox.createImageData(w, h)
  let changed = 0
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])
    if (d > 30) { changed++; od.data[i] = 255; od.data[i + 1] = 0; od.data[i + 2] = 80; od.data[i + 3] = 255 }
    else { const g = (db[i] + db[i + 1] + db[i + 2]) / 3; od.data[i] = od.data[i + 1] = od.data[i + 2] = 200 + g / 5; od.data[i + 3] = 255 }
  }
  ox.putImageData(od, 0, 0)
  return { png: out.toDataURL('image/png'), changedPct: Math.round((changed / (w * h)) * 10000) / 100 }
}`

/**
 * @param {{ beforeUrl?: string, afterUrl?: string, routes?: string[], cwd: string, viewports?: string[], timeoutMs?: number }} o
 */
export async function captureVisuals(o) {
  if (!o.beforeUrl || !o.afterUrl) return { skipped: 'No before/after URLs were provided.', shots: [] }
  const pw = await loadPlaywright(o.cwd)
  if (!pw) return { skipped: 'Playwright is not installed (looked in the repo and the global npm root).', shots: [] }
  const routes = o.routes && o.routes.length ? o.routes : ['/']
  const vps = (o.viewports || ['desktop', 'mobile']).filter((v) => VIEWPORTS[v])
  let browser
  try {
    browser = await pw.chromium.launch({ executablePath: process.env.REVIEW_COCKPIT_CHROMIUM || undefined })
  } catch (e) {
    return { skipped: `Playwright could not launch Chromium: ${String(e.message).split('\n')[0]}`, shots: [] }
  }
  const shots = []
  try {
    for (const route of routes) {
      for (const vp of vps) {
        const ctx = await browser.newContext({ viewport: VIEWPORTS[vp], serviceWorkers: 'block' })
        const page = await ctx.newPage()
        const grab = async (url) => {
          try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: o.timeoutMs || 20000 })
            return { png: `data:image/png;base64,${(await page.screenshot()).toString('base64')}`, error: '' }
          } catch (e) { return { png: '', error: String(e.message).split('\n')[0] } }
        }
        const before = await grab(joinUrl(o.beforeUrl, route))
        const after = await grab(joinUrl(o.afterUrl, route))
        let diff = { png: '', changedPct: null }
        if (before.png && after.png) {
          await page.goto('about:blank')
          diff = await page.evaluate(`(${DIFF_FN})(${JSON.stringify([before.png, after.png])})`)
        }
        shots.push({ route, viewport: vp, before, after, diff })
        await ctx.close()
      }
    }
  } finally {
    await browser.close()
  }
  return { skipped: '', shots }
}
