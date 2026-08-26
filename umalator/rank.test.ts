import assert from 'node:assert/strict';
import test from 'node:test';

import { assignLongitudinalRanks, compareRank, rankTarget } from '../uma-skill-tools/Rank.ts';
import { initializeFieldLanes, updateLongitudinalFieldState } from '../uma-skill-tools/FieldState.ts';
import { interpolateFinishGap, interpolateFinishTime } from './FinishInterpolation.ts';

test('longitudinal ranks are descending and ties are stable', () => {
	const runners = [10, 30, 20, 20].map(pos => ({pos, rank: 0, fieldSize: 0}));
	assignLongitudinalRanks(runners);
	assert.deepEqual(runners.map(r => r.rank), [4, 1, 2, 3]);
	assert.deepEqual(runners.map(r => r.fieldSize), [4, 4, 4, 4]);
});

test('rank and order_rate comparisons use the live field size', () => {
	assert.equal(rankTarget(50, 9, true), 5);
	assert.equal(compareRank(6, 'eq', 6, 9), true);
	assert.equal(compareRank(5, 'lte', 50, 9, true), true);
	assert.equal(compareRank(6, 'lte', 50, 9, true), false);
	assert.equal(compareRank(2, 'neq', 2, 9), false);
});

function fieldRunner(pos: number, currentSpeed = 20, targetSpeed = 20) {
	return {
		pos, currentSpeed, targetSpeed, rank: 0, fieldSize: 0, lastFieldRank: 0,
		nearestAheadDistance: Infinity, nearestBehindDistance: Infinity,
		distanceFromLeader: 0, distanceFromLast: 0, fieldSpread: 0,
		nearCount: 0, visibleHorseCount: 0, blockedFront: false,
		gateRoll: 999,
		lanePosition: 0, laneTarget: 0, laneSpeed: 0, laneInitialized: false,
		phase: 1, horse: {power: 1100, strategy: 'Sasi', popularity: 1},
		course: {distance: 120, corners: [{start: 90, length: 15}]},
		blockedFrontTime: 0, blockedSideTime: 0, blockedAllTime: 0,
		infrontNearLaneTime: 0, behindNearLaneTime: 0, behindNearLaneTimeSet1: 0,
		isSurrounded: false, hasOvertakeTarget: false, overtakeTargetTime: 0,
		overtakeTargetNoOrderUpTime: 0,
		changeOrderOneTime: 0, changeOrderUpMiddle: 0, changeOrderUpEndAfter: 0,
		changeOrderUpFinalCornerAfter: 0, laneMovementType: 0,
		sameStrategyCount: 1, sameStrategyRate: 100, popularityOneSameStrategy: true,
		isBehindIn: false
	} as any;
}

test('optional lanes apply documented lateral blocking geometry and move continuously', () => {
	const separated = [fieldRunner(10, 21, 22), fieldRunner(11, 20, 20)];
	initializeFieldLanes(separated, [0, 3]);
	updateLongitudinalFieldState(separated, 1 / 15, true);
	assert.equal(separated[0].blockedFront, false);

	const sameLane = [fieldRunner(10, 21, 22), fieldRunner(11, 20, 20)];
	initializeFieldLanes(sameLane, [0, 0]);
	updateLongitudinalFieldState(sameLane, 1 / 15, true);
	assert.equal(sameLane[0].blockedFront, true);
	assert.equal(sameLane[0].laneTarget, 1);
	assert.ok(sameLane[0].lanePosition > 0 && sameLane[0].lanePosition < 1);
});

test('lane-enabled post permutation is shared with post_number conditions', () => {
	const runners = [fieldRunner(0), fieldRunner(0), fieldRunner(0)];
	initializeFieldLanes(runners, [2, 0, 1], true);
	assert.deepEqual(runners.map(runner => runner.lanePosition), [2, 0, 1]);
	assert.deepEqual(runners.map(runner => runner.gateRoll % runners.length), [2, 0, 1]);

	const legacy = [fieldRunner(0), fieldRunner(0)];
	initializeFieldLanes(legacy, [1, 0]);
	assert.deepEqual(legacy.map(runner => runner.gateRoll), [999, 999]);
});

test('longitudinal field state supplies proximity and conservative blocking checks', () => {
	const runners = [fieldRunner(10, 21, 22), fieldRunner(11, 20, 20), fieldRunner(20, 20, 20)];
	updateLongitudinalFieldState(runners, 1 / 15);
	assert.equal(runners[2].rank, 1);
	assert.equal(runners[1].nearestBehindDistance, 1);
	assert.equal(runners[0].nearestAheadDistance, 1);
	assert.equal(runners[0].blockedFront, true);
	assert.equal(runners[0].blockedFrontTime, 1 / 15);
	assert.equal(runners[0].hasOvertakeTarget, true);
	assert.equal(runners[2].blockedFront, false);
	assert.equal(runners[2].distanceFromLeader, 0);
	assert.equal(runners[0].fieldSpread, 10);
});

test('blocked overtake targets can use current speed for the speed comparison', () => {
	const pursuer = fieldRunner(5, 21, 21);
	const blockedTarget = fieldRunner(10, 20, 22);
	const blocker = fieldRunner(11.5, 22, 22);
	const runners = [pursuer, blockedTarget, blocker];
	updateLongitudinalFieldState(runners, 1 / 15);
	assert.equal(blockedTarget.blockedFront, true);
	assert.equal(pursuer.hasOvertakeTarget, true);

	const unblockedTarget = fieldRunner(10, 20, 22);
	const unblocked = [fieldRunner(5, 21, 21), unblockedTarget];
	updateLongitudinalFieldState(unblocked, 1 / 15);
	assert.equal(unblocked[0].hasOvertakeTarget, false);
});

test('overtake target timers distinguish pursuers from runners being pursued', () => {
	const target = fieldRunner(10, 20, 20);
	const pursuerX = fieldRunner(5, 21, 22);
	const pursuerY = fieldRunner(3, 20, 21);
	const runners = [target, pursuerX, pursuerY];

	updateLongitudinalFieldState(runners, 1 / 15);
	assert.equal(target.hasOvertakeTarget, false);
	assert.ok(Math.abs(target.overtakeTargetTime - 1 / 15) < 1e-12);
	assert.equal(target.overtakeTargetNoOrderUpTime, 0);
	assert.ok(Math.abs(pursuerX.overtakeTargetNoOrderUpTime - 1 / 15) < 1e-12);

	// A handoff must not combine two different pursuers' partial durations.
	for (let i = 1; i < 8; ++i) updateLongitudinalFieldState(runners, 1 / 15);
	pursuerX.currentSpeed = 20;
	pursuerY.currentSpeed = 21;
	for (let i = 0; i < 7; ++i) updateLongitudinalFieldState(runners, 1 / 15);
	assert.ok(Math.abs(target.overtakeTargetTime - 7 / 15) < 1e-12);
	for (let i = 0; i < 8; ++i) updateLongitudinalFieldState(runners, 1 / 15);
	assert.ok(Math.abs(target.overtakeTargetTime - 1) < 1e-12);
});

test('full-field order-change counters use live rank gains in their course regions', () => {
	const runners = [fieldRunner(110), fieldRunner(100), fieldRunner(90), fieldRunner(80)];
	updateLongitudinalFieldState(runners, 1 / 15);
	const overtaker = runners[3];
	let activeOvertakes = 0;
	overtaker.onRaceEvent = event => {
		if (event.type == 'overtake') activeOvertakes += event.count;
	};
	overtaker.pos = 105;
	updateLongitudinalFieldState(runners, 1 / 15);
	assert.equal(overtaker.changeOrderOneTime, -2);
	assert.equal(activeOvertakes, 2);
	assert.equal(overtaker.changeOrderUpEndAfter, 2);
	assert.equal(overtaker.changeOrderUpFinalCornerAfter, 2);
	overtaker.pos = 120;
	updateLongitudinalFieldState(runners, 1 / 15);
	assert.equal(overtaker.changeOrderOneTime, -1);
	assert.equal(overtaker.changeOrderUpEndAfter, 3);
	assert.equal(overtaker.changeOrderUpFinalCornerAfter, 3);
	updateLongitudinalFieldState(runners, 1 / 15);
	assert.equal(overtaker.changeOrderOneTime, 0);
	assert.equal(overtaker.changeOrderUpEndAfter, 3);

	const middle = [fieldRunner(70), fieldRunner(60)];
	updateLongitudinalFieldState(middle, 1 / 15);
	middle[1].pos = 75;
	updateLongitudinalFieldState(middle, 1 / 15);
	assert.equal(middle[1].changeOrderUpMiddle, 1);
	assert.equal(middle[1].changeOrderUpEndAfter, 0);
});

test('finish interpolation preserves within-tick crossing order and distance', () => {
	const first = {startPosition: 1599, endPosition: 1600.4, startTime: 70, endTime: 70 + 1 / 15};
	const second = {startPosition: 1598.8, endPosition: 1600.2, startTime: 70, endTime: 70 + 1 / 15};
	assert.ok(interpolateFinishTime(1600, first)! < interpolateFinishTime(1600, second)!);
	assert.ok(Math.abs(interpolateFinishGap(1600, first, second)! + 0.08) < 1e-10);
});

test('finish interpolation reports fractional gains smaller than one simulation tick', () => {
	const baseline = {startPosition: 1598.9, endPosition: 1600.1, startTime: 70, endTime: 70 + 1 / 15};
	const improved = {startPosition: 1599.35, endPosition: 1600.55, startTime: 70, endTime: 70 + 1 / 15};
	const opponent = {startPosition: 1599, endPosition: 1600.2, startTime: 70, endTime: 70 + 1 / 15};
	const baselineGap = interpolateFinishGap(1600, baseline, opponent)!;
	const improvedGap = interpolateFinishGap(1600, improved, opponent)!;
	assert.ok(Math.abs((baselineGap - improvedGap) - 0.18) < 1e-10);
});
