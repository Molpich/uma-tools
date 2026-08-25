import test from 'node:test';
import assert from 'node:assert/strict';

import { accumulateMonteCarloRun, createMonteCarloAccumulator, summarizeMonteCarlo } from './montecarlo.ts';

function run(p0: number[], p1: number[], finish0 = 2, finish1 = 2, activations: any[] = []) {
	return {
		t: [[1, finish0], [1, finish1]],
		p: [p0, p1],
		v: [[10,20], [8,18]],
		sk: [new Map(activations), new Map()]
	};
}

test('all-run means, lead quantiles, finish capping, and activation rates', () => {
	const acc = createMonteCarloAccumulator([['skill'], []], 1);
	accumulateMonteCarloRun(acc, run([40,100], [30,100], 2, 2, [['skill', [[40, 60, 1, 1.5]]]]), 100);
	accumulateMonteCarloRun(acc, run([20,100], [50,100], 2, 2), 100);
	// A slower third run extends the grid. The first two finished runners must be backfilled at 100 m.
	accumulateMonteCarloRun(acc, run([25,100], [20,80], 2, 3), 100);
	const stats = summarizeMonteCarlo(acc);

	assert.deepEqual(stats.time, [0,1,2,3]);
	assert.deepEqual(stats.meanPosition[0], [0, 85/3, 100, 100]);
	assert.deepEqual(stats.meanPosition[1], [0, 100/3, 250/3, 100]);
	assert.deepEqual(stats.meanVelocity[0], [0, 10, 20, 0]);
	assert.deepEqual(stats.meanVelocity[1], [0, 8, 49/3, 6]);
	assert.ok(stats.identityMaxError < 1e-12);
	assert.equal(stats.lead[1].mean, -5);
	assert.equal(stats.lead[1].median, 5);
	assert.equal(stats.lead[3].mean, 0);
	assert.equal(stats.skillActivations[0][0].activationRate, 1/3);
	assert.equal(stats.skillActivations[0][0].neverActivated, 2);
	assert.equal(stats.skillActivations[0][0].position.median, 40);
	assert.equal(stats.skillActivations[0][0].time.median, 1);
});

test('relative lead is resampled against the frontmost runner position', () => {
	const acc = createMonteCarloAccumulator([[], []], 1, 10);
	accumulateMonteCarloRun(acc, run([50,100], [30,80], 2, 3), 100);
	const stats = summarizeMonteCarlo(acc);

	assert.equal(stats.distance[5], 50);
	assert.equal(stats.leadByDistance[5].mean, 20);
	assert.equal(stats.leadByDistance[5].median, 20);
	assert.equal(stats.leadByDistance[0].mean, 0);
	assert.equal(stats.leadByDistance.at(-1).mean, 45);
});
