import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runWorker } from './worker-test-harness.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function defaultHorse() {
	return {
		outfitId: '', starCount: 3,
		speed: 1600, stamina: 1300, power: 1100, guts: 800, wisdom: 1100,
		strategy: 'Senkou', distanceAptitude: 'S', surfaceAptitude: 'A', strategyAptitude: 'A',
		aptitudes: ['S','S','S','S','A','A','A','A','A','A'],
		skills: new Map(), samplePolicies: new Map(), uniqueLv: 1, mood: 2, popularity: 1
	};
}

function comparisonInput(rankAwareField = false) {
	const courses = JSON.parse(readFileSync(resolve(repoRoot, 'umalator-global/course_data.json'), 'utf8'));
	return {
		nsamples: 3,
		course: courses['10903'],
		racedef: {groundCondition: 1, weather: 2, season: 3, time: 3, grade: 100, skillId: '', numUmas: 9},
		uma1: defaultHorse(), uma2: defaultHorse(),
		options: {seed: 2615953739, usePosKeep: true, useCompeteTop: true, useIntChecks: false,
			rankAwareField, fieldSize: 5}
	};
}

function finalCompare(messages) {
	return messages.filter(message => message.type === 'compare').at(-1);
}

test('rank-aware worker runs a deterministic shared-clock field', () => {
	const current = readFileSync(resolve(repoRoot, 'umalator-global/simulator.worker.js'), 'utf8');
	const input = comparisonInput(true);
	const first = finalCompare(runWorker(current, 'compare', input));
	const second = finalCompare(runWorker(current, 'compare', input));
	assert.equal(first.results.results.length, 3);
	assert.equal(first.results.runData.experimental.rankAwareField, true);
	assert.equal(first.results.runData.experimental.fieldSize, 5);
	assert.equal(first.results.runData.winRate.total, 3);
	assert.equal(first.results.runData.fieldWinRate.total, 3);
	assert.equal(first.results.runData.fieldWinRate.wins.length, 2);
	assert.ok(first.results.runData.meanrun.t[0].length > 0);
	assert.ok(first.results.runData.meanrun.t[1].length > 0);
	assert.equal(first.results.runData.medianrun.fieldReplay.runners.length, 5);
	assert.ok(first.results.runData.medianrun.fieldReplay.t.length > 1);
	first.results.runData.medianrun.fieldReplay.runners.forEach(runner => {
		assert.equal(runner.p.length, first.results.runData.medianrun.fieldReplay.t.length);
		assert.equal(runner.lane.length, first.results.runData.medianrun.fieldReplay.t.length);
		assert.equal(runner.rank.length, first.results.runData.medianrun.fieldReplay.t.length);
		assert.equal(runner.v.length, first.results.runData.medianrun.fieldReplay.t.length);
		assert.equal(runner.accelBonus.length, first.results.runData.medianrun.fieldReplay.t.length);
		assert.equal(runner.accelTotal.length, first.results.runData.medianrun.fieldReplay.t.length);
	});
	assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('configured opponents participate in the field', () => {
	const current = readFileSync(resolve(repoRoot, 'umalator-global/simulator.worker.js'), 'utf8');
	const input = comparisonInput(true);
	input.nsamples = 5;
	input.options.fieldSize = 3;
	const opponent = defaultHorse();
	opponent.speed = 2000; opponent.stamina = 2000; opponent.power = 2000; opponent.guts = 2000; opponent.wisdom = 2000;
	input.fieldUmas = [opponent];
	const result = finalCompare(runWorker(current, 'compare', input)).results;
	assert.ok(result.runData.fieldWinRate.wins[0] + result.runData.fieldWinRate.wins[1] < input.nsamples);
});
