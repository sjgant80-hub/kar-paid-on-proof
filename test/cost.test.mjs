import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staffTime, NLW_2026_GBP, NLW_SOURCE } from '../sdk/cost.mjs';

test('staff time at the floor: jobs x minutes / 60 hours, times the rate, times 12 for a year', () => {
  const r = staffTime({ jobsPerMonth: 600, minutesPerCheck: 5 });
  assert.equal(r.hoursPerMonth, 50);
  assert.equal(r.rate, 12.71);
  assert.equal(r.perMonth, 50 * 12.71);
  assert.equal(r.perYear, 50 * 12.71 * 12);
  assert.equal(NLW_2026_GBP, 12.71);
  assert.match(NLW_SOURCE, /12\.71/);
});

test('a given rate overrides the floor; zero is allowed', () => {
  assert.equal(staffTime({ jobsPerMonth: 60, minutesPerCheck: 1, hourlyRate: 30 }).perMonth, 30);
  assert.deepEqual(staffTime({ jobsPerMonth: 0, minutesPerCheck: 0, hourlyRate: 0 }), { hoursPerMonth: 0, perMonth: 0, perYear: 0, rate: 0 });
  assert.equal(staffTime({ jobsPerMonth: '120', minutesPerCheck: '2' }).hoursPerMonth, 4);
});

test('negative, non-numeric, infinite or missing input gives null, never a throw', () => {
  for (const bad of [{ jobsPerMonth: -1, minutesPerCheck: 1 }, { jobsPerMonth: 1, minutesPerCheck: -1 }, { jobsPerMonth: 1, minutesPerCheck: 1, hourlyRate: -1 },
    { jobsPerMonth: 'x', minutesPerCheck: 1 }, { jobsPerMonth: 1, minutesPerCheck: 'x' }, { jobsPerMonth: 1, minutesPerCheck: 1, hourlyRate: 'x' },
    { jobsPerMonth: Infinity, minutesPerCheck: 1 }, { jobsPerMonth: 1e308, minutesPerCheck: 1e308 }, {}, null, undefined]) {
    assert.equal(staffTime(bad), null);
  }
});
