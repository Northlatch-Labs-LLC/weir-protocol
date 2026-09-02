// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>

/**
 * The hosting artifacts name only what the server reads, and never a secret.
 *
 * # What this pins, statically
 *
 * A Dockerfile and a service definition are prose the machine executes. What can go wrong in them
 * is quiet: an ENV that hands a key to a public container, a variable the server has never heard
 * of, a ceiling that drifted from the shape. So every variable both files name is checked against
 * the two lists the code exports — `AGENT_ENVIRONMENT` (what the agent library reads) and `ENV`
 * (what the server reads) — plus the two the platform sets (`PORT`, `NODE_ENV`); the two names
 * that must NEVER appear are asserted absent; the image runs as a named non-root user and copies
 * no `.env`; the build context excludes every `.env*`; the service carries the shape's ceilings.
 *
 * # What this does not do
 *
 * It does not build the image and it does not start the server. Both are processes on the machine
 * this runs on and are exercised only against a real deployment; `scripts/acceptance-probes.sh` is what
 * runs against the deployed URL. The PR that carries these files says so.
 */

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENVIRONMENT, ENV } from '../src/transport.js';

let checks = 0;
let failures = 0;
function check(what: string, fn: () => void): void {
  checks += 1;
  try {
    fn();
    console.log(`  ok  ${what}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${what}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const here = join(import.meta.dirname, '..');
const root = join(here, '..', '..');
const dockerfile = readFileSync(join(here, 'Dockerfile'), 'utf8');
const service = readFileSync(join(here, 'deploy', 'cloudrun.service.yaml'), 'utf8');
const ignore = readFileSync(join(root, '.dockerignore'), 'utf8');
const probes = readFileSync(join(here, 'scripts', 'acceptance-probes.sh'), 'utf8');

const code = (s: string) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const ALLOWED = new Set<string>([...AGENT_ENVIRONMENT, ...Object.values(ENV), 'PORT', 'NODE_ENV']);
const FORBIDDEN = new Set<string>([ENV.key, 'PROJECTX_SOCIAL_AGENT_SECRET']);

/** ENV names the Dockerfile sets. `ENV A=1 \` continuation lines included. */
function dockerEnvNames(src: string): string[] {
  const names: string[] = [];
  let inEnv = false;
  for (const raw of code(src).split('\n')) {
    const line = raw.trim();
    if (/^ENV\b/.test(line)) inEnv = true;
    if (inEnv) {
      for (const m of line.replace(/^ENV\s+/, '').matchAll(/([A-Z_][A-Z0-9_]*)=/g)) names.push(m[1]!);
      if (!line.endsWith('\\')) inEnv = false;
    }
  }
  return names;
}
/** `- name: X` entries under env in the service YAML. */
const yamlEnvNames = (src: string) => [...code(src).matchAll(/- name:\s*([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]!);

console.log('=== variables ===');
const dockerNames = dockerEnvNames(dockerfile);
const yamlNames = yamlEnvNames(service);
check('the Dockerfile sets only variables the server or the platform reads', () => {
  assert.ok(dockerNames.length >= 3, dockerNames.join(', '));
  for (const n of dockerNames) assert.ok(ALLOWED.has(n), `${n} is not a variable this server reads`);
});
check('the service definition names only variables the server or the agent library reads', () => {
  assert.ok(yamlNames.length >= 10, yamlNames.join(', '));
  for (const n of yamlNames) assert.ok(ALLOWED.has(n), `${n} is not a variable this server reads`);
});
check('the service definition supplies every variable the agent library requires', () => {
  for (const n of AGENT_ENVIRONMENT) {
    if (n === 'PROJECTX_SOCIAL_KEY_REGISTRY_ID') continue; // optional, by the SDK's own word
    assert.ok(yamlNames.includes(n), `${n} missing from the service definition`);
  }
});
check('neither file names the key or the secret — not even as a comment-free placeholder', () => {
  for (const n of FORBIDDEN) {
    assert.ok(!dockerNames.includes(n), `${n} in the Dockerfile`);
    assert.ok(!yamlNames.includes(n), `${n} in the service definition`);
    assert.ok(!new RegExp(`${n}\\s*=`).test(code(dockerfile)), `${n} assigned in the Dockerfile`);
  }
});
check('the two files agree on the port and the host', () => {
  assert.ok(/WEIR_MCP_HTTP_PORT=8080/.test(dockerfile) && /PORT=8080/.test(dockerfile));
  assert.ok(/name: WEIR_MCP_HTTP_PORT\s*\n\s*value: "8080"/.test(service));
  assert.ok(/name: WEIR_MCP_HTTP_HOST\s*\n\s*value: "0\.0\.0\.0"/.test(service));
  assert.ok(/containerPort: 8080/.test(service));
});

console.log('=== the image ===');
check('runs as a named non-root user, created in the runtime stage', () => {
  assert.ok(/adduser -S -G projectx projectx/.test(dockerfile));
  const users = [...code(dockerfile).matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(users, ['projectx']);
});
check('copies no .env and the build context excludes every .env*', () => {
  assert.ok(!/COPY[^\n]*\.env/.test(code(dockerfile)));
  for (const line of ['.env', '.env.*', '**/.env', '**/.env.*']) assert.ok(ignore.split('\n').includes(line), `${line} missing from .dockerignore`);
});
check('starts the server in HTTP mode and nothing else', () => {
  assert.ok(/ENTRYPOINT \["node", "packages\/mcp\/dist\/index\.js", "--http"\]/.test(dockerfile));
  assert.ok(!/--stdio/.test(code(dockerfile)));
});

console.log('=== the service ===');
check('carries the shape: max 2 instances, 512Mi, 1 vCPU, 60 s, min 0', () => {
  assert.ok(/maxScale: "2"/.test(service));
  assert.ok(/minScale: "0"/.test(service));
  assert.ok(/memory: 512Mi/.test(service));
  assert.ok(/cpu: "1"/.test(service));
  assert.ok(/timeoutSeconds: 60/.test(service));
});
check('answers to one Host — the allowlist is a placeholder for the door, and origins stay refused', () => {
  assert.ok(/name: WEIR_MCP_ALLOWED_HOSTS\s*\n\s*value: \$\{MCP_HOSTNAME\}/.test(service));
  assert.ok(/name: WEIR_MCP_ALLOWED_ORIGINS\s*\n\s*value: ""/.test(service));
});
check('bakes in no project id, no image digest and no chain id', () => {
  assert.ok(!/0x[0-9a-f]{20,}/.test(code(service)), 'a chain id is written into the template');
  assert.ok(/\$\{PROJECT_ID\}/.test(service) && /\$\{TAG\}/.test(service));
});

console.log('=== the probes ===');
check('the probe script is executable and fails closed', () => {
  assert.ok((statSync(join(here, 'scripts', 'acceptance-probes.sh')).mode & 0o111) !== 0, 'not executable');
  assert.ok(/set -euo pipefail/.test(probes));
  assert.ok(/exit 1/.test(probes));
});
check('the probe script carries all seven probes from the shape', () => {
  for (const needle of ['Host rebind.example', 'Origin https://evil.example', 'a Cookie is refused', 'GET / is 404', 'Set-Cookie', 'mcp-session-id', 'tools/list is the read set']) {
    assert.ok(probes.includes(needle), `missing probe: ${needle}`);
  }
  assert.ok(/READ_SET='weir_balance weir_quote weir_read weir_search'/.test(probes));
});

console.log(`${checks - failures}/${checks} checks passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;
