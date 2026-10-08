import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const project = fileURLToPath(new URL('../', import.meta.url));
const spec = JSON.parse(await readFile(join(project, 'openapi.json'), 'utf8'));
const source = await readFile(join(project, 'src/api.rs'), 'utf8');
const routes = [...source.matchAll(/\.route\(\s*"([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(Object.keys(spec.paths).sort(), [...new Set(routes)].sort());
assert.equal(spec.openapi, '3.1.0');
assert.equal(spec.info.version, '0.5.0-rc.1');
function checkRefs(value) {
  if (!value || typeof value !== 'object') return;
  if (value.$ref) {
    assert(value.$ref.startsWith('#/'), 'Only local API references are expected.');
    const referenced = value.$ref.slice(2).split('/').reduce((current, key) => current?.[key], spec);
    assert(referenced, `Unresolved API reference: ${value.$ref}`);
  }
  for (const nested of Object.values(value)) checkRefs(nested);
}
checkRefs(spec);
assert.deepEqual(spec.components.schemas.MetricInput.required.sort(), ['current_replicas', 'requests_per_second', 'service']);
assert.deepEqual(spec.paths['/api/v1/observability/ready'].get.security, []);
assert(spec.paths['/api/v1/metrics'].post.parameters.some(parameter => parameter.name === 'X-FluxScale-Execution-Mode' && parameter.required));
console.log(`PASS: ${routes.length} API routes, local schema references, readiness and ingest-mode contract.`);
