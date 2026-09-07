#!/usr/bin/env node
/**
 * Independent-critic runner for a factory candidate (derived from the critic-gated-build
 * template). Clean clone of committed HEAD → live-capture evidence bundle fetched THROUGH
 * Cloudflare Access with the service token → codex in a read-only sandbox with a fresh context
 * → verdict JSON + transcript under factory-reports/<key>/.
 *
 * Usage: node scripts/critic.mjs --url https://<preview-host> --key <key>
 * Exits 2 when no JSON verdict could be extracted.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : dflt; };
const BASE = arg("--url");
const KEY = arg("--key", "a");
if (!BASE) { console.error("usage: critic.mjs --url <https://host> --key <key>"); process.exit(1); }

// ─── CONFIG ──────────────────────────────────────────────────────────────
const CAPTURE_PATHS = [["/", "index.html.txt"], ["/health", "health.txt"]];
const EVIDENCE = [];                                   // smoke already ran; its artifacts are copied below
const COPY_DIRS = [`factory-reports/${KEY}`];
const CRITIC = { cmd: "codex", args: ["exec", "--skip-git-repo-check", "--sandbox", "read-only"] };
const ACCESS_HEADERS = {};
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  ACCESS_HEADERS["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
  ACCESS_HEADERS["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
}
// ─────────────────────────────────────────────────────────────────────────

const repoRoot = process.cwd();
const work = join(tmpdir(), `critic-${KEY}-${Date.now()}`);
execFileSync("git", ["clone", "--depth", "1", "--quiet", `file://${repoRoot}`, work]);

function tryRun(cmd, args, timeout = 300_000) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    return `${err.stdout ?? ""}\n${err.stderr ?? ""}\nEXITED NON-ZERO`;
  }
}

const cap = join(work, "live-capture");
mkdirSync(cap, { recursive: true });

const sha = tryRun("git", ["rev-parse", "HEAD"]).trim();
writeFileSync(
  join(cap, "gates.txt"),
  [
    `revision under review: ${sha}`,
    `\n$ npm test\n${tryRun("npm", ["test"])}`,
    `\n$ npx wrangler deploy --dry-run --config wrangler.preview.${KEY}.jsonc\n${tryRun("npx", ["wrangler", "deploy", "--dry-run", "--config", `wrangler.preview.${KEY}.jsonc`])}`,
    `\n$ gh run list (GitHub Actions CI)\n${tryRun("gh", ["run", "list", "--limit", "8"])}`,
  ].join("\n"),
);

const timings = [];
for (const [path, name] of CAPTURE_PATHS) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, { headers: ACCESS_HEADERS, redirect: "manual" });
  const ms = Date.now() - t0;
  const body = await res.text();
  const headers = [...res.headers.entries()].filter(([k]) => !/^cf-access|^set-cookie/i.test(k)).map(([k, v]) => `${k}: ${v}`).join("\n");
  writeFileSync(join(cap, name), `# GET ${path}\n# status: ${res.status}  time: ${ms}ms\n\n## headers\n${headers}\n\n## body\n${body.slice(0, 60_000)}`);
  timings.push({ path, status: res.status, ms, bytes: body.length });
}
writeFileSync(join(cap, "timings.json"), JSON.stringify(timings, null, 2));

for (const step of EVIDENCE) writeFileSync(join(cap, step.file), tryRun(step.cmd, step.args, 600_000));
for (const dir of COPY_DIRS) {
  try { cpSync(dir, join(cap, dir.split("/").pop()), { recursive: true }); } catch { /* optional */ }
}

const prompt = readFileSync("scripts/critic-prompt.md", "utf8").replaceAll("{{LIVE_URL}}", BASE);
console.error(`[critic] candidate ${KEY}: running ${CRITIC.cmd} in ${work}`);
let out = "";
try {
  out = execFileSync(CRITIC.cmd, [...CRITIC.args, "--cd", work, "-"], {
    input: prompt, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60 * 1000, stdio: ["pipe", "pipe", "ignore"],
  });
} catch (err) {
  out = err.stdout ?? "";
  if (!out) throw err;
}

const blocks = [...out.matchAll(/```json\s*([\s\S]*?)```/g)];
let verdict = null;
for (let i = blocks.length - 1; i >= 0 && !verdict; i--) {
  try { verdict = JSON.parse(blocks[i][1]); } catch { /* try earlier block */ }
}

const outDir = `factory-reports/${KEY}`;
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "critic.md"), out);
if (verdict) {
  verdict.candidate = KEY;
  verdict.revision = sha;
  verdict.capturedAt = new Date().toISOString();
  writeFileSync(join(outDir, "critic.json"), JSON.stringify(verdict, null, 2));
  console.log(JSON.stringify(verdict, null, 2));
} else {
  console.error(`[critic] FAILED to extract a JSON verdict — see ${outDir}/critic.md`);
  process.exit(2);
}
