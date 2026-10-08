import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTrafficSeries } from '../src/lib/api.ts';

const sample = { timestamp: '2026-10-08T00:00:00Z', requests_per_second: 10, current_replicas: 2 };
test('empty history stays empty and unknown capacity stays unknown', () => {
  assert.deepEqual(buildTrafficSeries([]), []);
  const [point] = buildTrafficSeries([sample]);
  assert.equal(point.actual, 10);
  assert.equal(point.capacity, null);
  assert.equal(buildTrafficSeries([sample], undefined, 0)[0].capacity, null);
});
test('capacity uses the supplied estimate and forecast starts at the recorded timestamp', () => {
  const decision = { desired_replicas: 3, prediction_horizon_seconds: 10, predicted_rps: 25 };
  const [actual, forecast] = buildTrafficSeries([sample], decision, 100);
  assert.equal(actual.capacity, 200);
  assert.equal(forecast.capacity, 300);
  assert.equal(forecast.actual, null);
  assert.equal(forecast.predicted, 25);
  assert.equal(Date.parse(forecast.timestamp) - Date.parse(actual.timestamp), 10_000);
});
