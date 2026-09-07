#!/usr/bin/env node
/**
 * Independent-critic runner for a factory candidate (derived from the critic-gated-build
 * template). Clean clone of committed HEAD → live-capture evidence bundle fetched THROUGH
 * Cloudflare Access with the service token → codex in a read-only sandbox with a fresh context
 * → verdict JSON + transcript under factory-reports/<key>/.
 *
 * Executes nothing the candidate wrote (THREAT_MODEL.md invariant 9): the only child processes
 * are git, gh, and the critic command. Gate evidence is CI's, read with `gh run list --commit`.
 * The critic runs with an allowlisted environment (no Access variable, no session credential),
 * reads no candidate instruction file (every AGENTS.md is removed from the evidence clone and
 * project docs are disabled), and its verdict is written only as a capped shape that matched no
 * secret pattern.
 *
 * Usage: node scripts/critic.mjs --url https://<preview-host> --key <key>
 * Exits 2 when no JSON verdict could be extracted, or when the verdict text matched a secret pattern.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : dflt; };
const BASE = arg("--url");
const KEY = arg("--key", "a");
if (!BASE) { console.error("usage: critic.mjs --url <https://host> --key <key>"); process.exit(1); }

// ─── CONFIG ──────────────────────────────────────────────────────────────
const CAPTURE_PATHS = [["/", "index.html.txt"], ["/health", "health.txt"]];
const COPY_DIRS = [`factory-reports/${KEY}`];          // smoke already ran; its artifacts are copied below
// `-c project_doc_max_bytes=0`: codex loads no AGENTS.md or other project doc from the clone (codex
// 0.153.4 accepts `-c key=value`). The files themselves are also removed after the clone, below.
const CRITIC = { cmd: "codex", args: ["exec", "-c", "project_doc_max_bytes=0", "--skip-git-repo-check", "--sandbox", "read-only"] };
const ACCESS_HEADERS = {};
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  ACCESS_HEADERS["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
  ACCESS_HEADERS["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
}
// The critic's environment is an allowlist, not a scrubbed copy: nothing from the session (the Access
// token, gh or cloud credentials, proxies) reaches codex unless it is named here.
const env = {};
for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'CODEX_HOME', 'SHELL', 'USER']) if (process.env[k] !== undefined) env[k] = process.env[k];
delete env.CF_ACCESS_CLIENT_ID;      // no-ops under the allowlist; kept so the invariant reads the same
delete env.CF_ACCESS_CLIENT_SECRET;
// ─────────────────────────────────────────────────────────────────────────

const repoRoot = process.cwd();
const work = join(tmpdir(), `critic-${KEY}-${Date.now()}`);
execFileSync("git", ["clone", "--depth", "1", "--quiet", `file://${repoRoot}`, work]);
// codex treats AGENTS.md (and AGENTS.override.md) as trusted instructions, and the candidate can
// commit one anywhere in its tree. Remove every copy (any case) from the evidence clone before the
// critic reads it.
const INSTRUCTION_FILES = new Set(["agents.md", "agents.override.md"]);
for (const rel of readdirSync(work, { recursive: true })) {
  if (INSTRUCTION_FILES.has(basename(rel).toLowerCase())) rmSync(join(work, rel), { force: true, recursive: true });
}

function tryRun(cmd, args, timeout = 300_000) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    return `${err.stdout ?? ""}\n${err.stderr ?? ""}\nEXITED NON-ZERO`;
  }
}

const cap = join(work, "live-capture");
mkdirSync(cap, { recursive: true });

// Gate evidence comes from CI, which is the only place the candidate's own test suite runs
// outside the Worker. Nothing from the candidate's package.json or config executes here.
const sha = tryRun("git", ["rev-parse", "HEAD"]).trim();
writeFileSync(
  join(cap, "gates.txt"),
  [
    `revision under review: ${sha}`,
    `\n$ gh run list --commit ${sha} (GitHub Actions CI for this revision; the gate is the "test" check concluding "success")\n${tryRun("gh", ["run", "list", "--commit", sha, "--json", "name,conclusion,url", "--limit", "10"])}`,
    `\n$ gh run list (recent GitHub Actions CI)\n${tryRun("gh", ["run", "list", "--limit", "8"])}`,
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

for (const dir of COPY_DIRS) {
  try { cpSync(dir, join(cap, dir.split("/").pop()), { recursive: true }); } catch { /* optional */ }
}

const prompt = readFileSync("scripts/critic-prompt.md", "utf8").replaceAll("{{LIVE_URL}}", BASE);
console.error(`[critic] candidate ${KEY}: running ${CRITIC.cmd} in ${work}`);
let out = "";
try {
  out = execFileSync(CRITIC.cmd, [...CRITIC.args, "--cd", work, "-"], {
    input: prompt, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60 * 1000, stdio: ["pipe", "pipe", "ignore"], env,
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
writeFileSync(join(outDir, "critic.md"), out);   // the transcript stays local (SKILL.md Phase 7); never committed
if (!verdict) {
  console.error(`[critic] FAILED to extract a JSON verdict — see ${outDir}/critic.md`);
  process.exit(2);
}

// The verdict is model output over candidate-controlled evidence, and codex can read the disk inside
// its sandbox. Only the fields the skill reads survive (`scores` is a five-key allowlist, so the model
// cannot add a key), every string is capped, and the JSON text is refused outright if it matches a
// secret pattern — those two steps, plus the fact that only the
// capped shape is ever committed, are what keep a leak out of the repository.
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const scores = verdict.scores && typeof verdict.scores === "object" ? verdict.scores : {};
const shaped = {
  candidate: KEY,
  revision: sha,
  capturedAt: new Date().toISOString(),
  scores: Object.fromEntries(['design','mobile_ux','completeness','performance','code_quality'].filter((k) => typeof scores[k] === 'number').map((k) => [k, scores[k]])),
  verdict: str(verdict.verdict, 40),
  requiredFixes: (Array.isArray(verdict.requiredFixes) ? verdict.requiredFixes : []).slice(0, 20).map((f) => ({
    severity: str(f?.severity, 40), category: str(f?.category, 40), title: str(f?.title, 120), detail: str(f?.detail, 400),
  })),
};
const SECRET_PATTERN = /-----BEGIN|oauth_token|refresh_token|ghp_[A-Za-z0-9]|gho_[A-Za-z0-9]|github_pat_|AKIA[0-9A-Z]{16}|CF_ACCESS_CLIENT|Bearer /;
const text = JSON.stringify(shaped, null, 2);
if (SECRET_PATTERN.test(text)) {
  console.error("[critic] verdict withheld: evidence matched a secret pattern");
  process.exit(2);
}
writeFileSync(join(outDir, "critic.json"), text);
console.log(text);
