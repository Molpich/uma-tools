import { CourseData } from '../uma-skill-tools/CourseData';
import type { GameHpPolicy } from '../uma-skill-tools/HpPolicy';
import { RaceParameters } from '../uma-skill-tools/RaceParameters';
import { FieldSkillEffect, PendingSkill, Perspective, RaceSolver, SkillRarity } from '../uma-skill-tools/RaceSolver';
import { RaceSolverBuilder, SkillTarget } from '../uma-skill-tools/RaceSolverBuilder';
import { initializeFieldLanes, updateLongitudinalFieldState } from '../uma-skill-tools/FieldState';
import { StrategyHelpers } from '../uma-skill-tools/HorseTypes';
import { Rule30CARng } from '../uma-skill-tools/Random';
import { HorseState, makeDefaultOpponent, uniqueSkillForUma } from '../components/HorseDefTypes';
import { getActivator, getDeactivator, instantiateSamplePolicy } from './compare';
import { interpolateFinishGap, interpolateFinishTime, StepSegment } from './FinishInterpolation';
import { accumulateMonteCarloRun, createMonteCarloAccumulator, summarizeMonteCarlo } from './montecarlo';

import skillmeta from '../skill_meta.json';

const DT = 1 / 15;
function configureBuilder(nsamples: number, course: CourseData, racedef: RaceParameters,
	horse: HorseState, otherHorse: HorseState, seed: [number, number], rank: number,
	fieldSize: number, options, skillPositions?: Map<string, any>, onActivate?: (skill: PendingSkill) => void) {
	const builder = new RaceSolverBuilder(nsamples)
		.seed(...seed).course(course).ground(racedef.groundCondition).weather(racedef.weather)
		.season(racedef.season).time(racedef.time).horse(horse).otherHorse(otherHorse)
		.rankAware(rank, fieldSize);
	const uniqueId = uniqueSkillForUma(horse.outfitId, horse.starCount);
	const wisdomSeeds = new Map<string, [number, number]>();
	const wisdomRng = new Rule30CARng(...seed);
	for (let i = 0; i < 20; ++i) wisdomRng.pair();
	Array.from(horse.skills.values()).sort((a, b) => +a - +b).forEach(id => {
		wisdomSeeds.set(id, wisdomRng.pair());
		builder.addSkill(id, Perspective.Self, id == uniqueId ? horse.uniqueLv : 1,
			instantiateSamplePolicy(horse.samplePolicies.get(id)));
	});
	if (options.pairSkillRngByGroup) {
		builder.withIndependentSkillSamples(new Map(Array.from(horse.skills.values(), id => [id, skillmeta[id].groupId])));
	}
	builder.withAsiwotameru();
	if (!CC_GLOBAL) builder.withStaminaSyoubu();
	if (options.usePosKeep) builder.useDefaultPacer();
	if (options.useCompeteTop) builder.withItidoriarasoi();
	if (options.useIntChecks) builder.withWisdomChecks(wisdomSeeds);
	if (skillPositions != null || onActivate != null) {
		const recordActivation = skillPositions == null ? null : getActivator(skillPositions, null);
		builder.onSkillActivate((state, id, perspective, skill) => {
			if (recordActivation != null) recordActivation(state, id, perspective);
			if (perspective == Perspective.Self && skill != null) onActivate?.(skill);
		});
	}
	if (skillPositions != null) {
		builder.onSkillDeactivate(getDeactivator(skillPositions, null, course));
	}
	return builder;
}

function fieldEffectTargets(effect: FieldSkillEffect, sourceIndex: number, targetIndex: number, solvers: RaceSolver[]) {
	if (sourceIndex == targetIndex) return false;
	const source = solvers[sourceIndex], target = solvers[targetIndex];
	const ahead = target.pos > source.pos;
	const behind = target.pos < source.pos;
	switch (effect.target) {
	case SkillTarget.All: return true;
	case SkillTarget.InFov: return ahead && target.pos - source.pos <= 20;
	case SkillTarget.AheadOfPosition:
	case SkillTarget.AheadOfSelf: return ahead;
	case SkillTarget.BehindSelf: return behind;
	case SkillTarget.EnemyStrategy: return effect.targetStrategy != null && StrategyHelpers.strategyMatches(target.horse.strategy, effect.targetStrategy);
	case SkillTarget.KakariAhead: return ahead && target.isKakari;
	case SkillTarget.KakariBehind: return behind && target.isKakari;
	case SkillTarget.KakariStrategy: return target.isKakari && effect.targetStrategy != null && StrategyHelpers.strategyMatches(target.horse.strategy, effect.targetStrategy);
	case SkillTarget.UsedRecovery: return target.activateCountHeal > 0;
	// Team membership and character-specific target metadata are not represented by this simulator.
	case SkillTarget.AllAllies:
	case SkillTarget.UmaId:
	default: return false;
	}
}

function routeFieldEffects(sourceIndex: number, skill: PendingSkill, solvers: RaceSolver[]) {
	if (skill.fieldEffects == null || skill.fieldEffects.length == 0 || solvers.length == 0) return;
	for (let targetIndex = 0; targetIndex < solvers.length; ++targetIndex) {
		const effects = skill.fieldEffects.filter(effect => fieldEffectTargets(effect, sourceIndex, targetIndex, solvers));
		solvers[targetIndex].applyExternalSkill(skill.skillId, skill.rarity as SkillRarity, effects);
	}
}

function recordFrame(data, index: number, solver: RaceSolver) {
	data.t[index].push(solver.accumulatetime.t);
	data.p[index].push(solver.pos);
	data.v[index].push(solver.currentSpeed + solver.modifiers.currentSpeed.acc + solver.modifiers.currentSpeed.err);
	data.hp[index].push((solver.hp as GameHpPolicy).hp);
}

function createFieldReplay(horses: HorseState[], courseDistance: number, dt: number) {
	const replay = {
		dt,
		courseDistance,
		t: [] as number[],
		runners: horses.map((horse, index) => ({
			index,
			outfitId: horse.outfitId,
			strategy: horse.strategy,
			p: [] as number[],
			lane: [] as number[],
			rank: [] as number[],
			v: [] as number[],
			accelBonus: [] as number[],
			accelTotal: [] as number[],
			state: [] as any[],
			skillActivations: [] as any[]
		}))
	};
	// Runtime-only bookkeeping. Keeping this non-enumerable prevents it from
	// being sent to the UI with the finished replay.
	Object.defineProperty(replay, '_finishState', {value: {
		finishedRanks: new Array(horses.length).fill(0),
		finishCount: 0
	}});
	return replay;
}

function replayBlockStatus(runner: RaceSolver, solvers: RaceSolver[], useLanes: boolean) {
	const ahead = solvers.filter(other => other != runner && other.pos > runner.pos).sort((a,b) => a.pos - b.pos);
	let front: RaceSolver[] = [];
	if (useLanes) {
		const blocker = ahead.find(other => {
			const gap = other.pos - runner.pos;
			const threshold = (1 - 0.6 * gap / 2) * 0.75;
			return gap < 2 && Math.abs(other.lanePosition - runner.lanePosition) <= threshold;
		});
		if (blocker != null) front = [blocker];
	} else if (ahead.length > 0 && ahead[0].pos - runner.pos < 2) {
		front = [ahead[0]];
	}
	const nearby = solvers.filter(other => other != runner && Math.abs(other.pos - runner.pos) < 1.05);
	const indexOf = other => solvers.indexOf(other);
	if (!useLanes) return {front: front.map(indexOf), side: nearby.map(indexOf), inner: [], outer: []};
	return {
		front: front.map(indexOf), side: [],
		inner: nearby.filter(other => runner.lanePosition - other.lanePosition > 0
			&& runner.lanePosition - other.lanePosition < 2).map(indexOf),
		outer: nearby.filter(other => other.lanePosition - runner.lanePosition > 0
			&& other.lanePosition - runner.lanePosition < 2).map(indexOf)
	};
}

function activePaceDownSkillIds(solver: RaceSolver) {
	return Array.from(new Set(solver.activeTargetSpeedSkills.concat(solver.activeCurrentSpeedSkills).map(skill => skill.skillId)));
}

function recordFieldReplayFrame(replay, solvers: RaceSolver[], time: number, courseDistance: number, useLanes: boolean) {
	const finishState = replay._finishState;
	const newlyFinished = solvers.map((solver, index) => ({solver, index}))
		.filter(({solver,index}) => solver.pos >= courseDistance && finishState.finishedRanks[index] == 0)
		// Estimate within-frame crossing order from overshoot and current speed.
		.sort((a,b) => (b.solver.pos - courseDistance) / Math.max(b.solver.currentSpeed, 0.001)
			- (a.solver.pos - courseDistance) / Math.max(a.solver.currentSpeed, 0.001));
	newlyFinished.forEach(({index}) => finishState.finishedRanks[index] = ++finishState.finishCount);
	const ranks = new Array(solvers.length);
	solvers.map((solver, index) => ({index, pos: Math.min(solver.pos, courseDistance)}))
		.filter(entry => finishState.finishedRanks[entry.index] == 0)
		.sort((a,b) => b.pos - a.pos || a.index - b.index)
		.forEach((entry, rank) => ranks[entry.index] = finishState.finishCount + rank + 1);
	finishState.finishedRanks.forEach((rank,index) => { if (rank > 0) ranks[index] = rank; });
	replay.t.push(time);
	solvers.forEach((solver, index) => {
		const runner = replay.runners[index];
		const paceDownSkills = activePaceDownSkillIds(solver);
		const paceDownEligible = solver.pacer != null && solver.pos < solver.posKeepEnd
			&& solver.pacer.pos - solver.pos < solver.posKeepMinThreshold
			&& solver.posKeepCooldown.t >= 0 && !solver.isKakari;
		runner.p.push(Math.min(solver.pos, courseDistance));
		runner.lane.push(solver.lanePosition);
		runner.rank.push(ranks[index]);
		runner.v.push(solver.pos >= courseDistance ? 0 : solver.currentSpeed + solver.modifiers.currentSpeed.acc + solver.modifiers.currentSpeed.err);
		runner.accelBonus.push(solver.modifiers.accel.acc + solver.modifiers.accel.err);
		runner.accelTotal.push(solver.accel);
		runner.state.push({
			paceDown: solver.isPaceDown,
			paceDownEndReason: solver.paceDownEndReason,
			paceDownEndSkills: solver.paceDownEndReason == 'speed-skill' ? paceDownSkills : [],
			paceDownPreventedBy: !solver.isPaceDown && paceDownEligible && paceDownSkills.length > 0 ? paceDownSkills : [],
			changeOrderOneTime: solver.changeOrderOneTime,
			changeOrderUpMiddle: solver.changeOrderUpMiddle,
			changeOrderUpEndAfter: solver.changeOrderUpEndAfter,
			changeOrderUpFinalCornerAfter: solver.changeOrderUpFinalCornerAfter,
			isBehindIn: solver.isBehindIn,
			block: replayBlockStatus(solver, solvers, useLanes)
		});
	});
}

/** Shared-clock field simulation with live longitudinal relationships and targeted effects.
 *  Lateral lanes and the physical blocking speed cap are deliberately not modeled. */
export function runRankAwareComparison(nsamples: number, course: CourseData, racedef: RaceParameters,
	uma1: HorseState, uma2: HorseState, seed: [number, number], options) {
	const fieldSize = Math.max(2, Math.min(18, Math.trunc(options.fieldSize || 9)));
	const horses = [uma1, uma2];
	const configuredOpponents: HorseState[] = options.fieldUmas || [];
	for (let i = 0; horses.length < fieldSize; ++i) horses.push(configuredOpponents[i] || makeDefaultOpponent(uma1, uma2, i));
	function createPass() {
		const seedRng = new Rule30CARng(...seed);
		const laneRng = new Rule30CARng((seed[0] ^ 0x6c616e65) >>> 0, (seed[1] ^ 0x706f7374) >>> 0);
		const skillPositions = horses.map(() => new Map());
		let activeSolvers: RaceSolver[] = [];
		const generators = horses.map((horse, i) => configureBuilder(nsamples, course, racedef, horse,
			i == 0 ? uma2 : uma1, seedRng.pair(), i + 1, fieldSize, options,
			skillPositions[i],
			skill => routeFieldEffects(i, skill, activeSolvers)).build());
		return {generators, skillPositions, setActiveSolvers: solvers => activeSolvers = solvers,
			initializeLanes(solvers: RaceSolver[]) {
				if (!options.simulateLanes) return;
				const posts = Array.from({length: solvers.length}, (_, index) => index);
				for (let i = posts.length - 1; i > 0; --i) {
					const j = laneRng.uniform(i + 1);
					[posts[i], posts[j]] = [posts[j], posts[i]];
				}
				initializeFieldLanes(solvers, posts, true);
			}};
	}
	const firstPass = createPass();

	const diff: number[] = [];
	const indexedResults: {value: number, index: number}[] = [];
	let min = Infinity, max = -Infinity, minrun, maxrun, meanrun, medianrun;
	let minrunIndex = -1, maxrunIndex = -1;
	const nspurt = [0, 0];
	const wins = [0, 0], fieldWins = [0, 0];
	let ties = 0, fieldTies = 0;
	const monteCarlo = createMonteCarloAccumulator([uma1.skills.values(), uma2.skills.values()]);

	for (let sample = 0; sample < nsamples; ++sample) {
		const solvers = firstPass.generators.map(generator => generator.next().value as RaceSolver);
		firstPass.setActiveSolvers(solvers);
		firstPass.initializeLanes(solvers);
		const data = {t: [[], []], p: [[], []], v: [[], []], hp: [[], []], sk: [null, null], sdly: [0, 0], dh: [0, 0]};
		let basinn: number | null = null;
		const interpolatedFinishTimes: (number | null)[] = solvers.map(() => null);
		while (solvers.some(solver => solver.pos < course.distance)) {
			updateLongitudinalFieldState(solvers, DT, !!options.simulateLanes);
			const segments: (StepSegment | null)[] = solvers.map(() => null);
			for (let i = 0; i < solvers.length; ++i) {
				const solver = solvers[i];
				if (solver.pos >= course.distance) continue;
				const startPosition = solver.pos;
				const startTime = solver.accumulatetime.t;
				solver.step(DT);
				const segment = segments[i] = {
					startPosition, endPosition: solver.pos,
					startTime, endTime: solver.accumulatetime.t
				};
				const finishTime = interpolateFinishTime(course.distance, segment);
				if (finishTime != null) interpolatedFinishTimes[i] = finishTime;
				if (i < 2) recordFrame(data, i, solver);
			}
			if (basinn == null && segments[0] != null && segments[1] != null) {
				basinn = interpolateFinishGap(course.distance, segments[0], segments[1]);
			}
		}
		data.sdly[0] = solvers[0].startDelay; data.sdly[1] = solvers[1].startDelay;
		solvers.forEach(solver => solver.cleanup());
		for (let i = 0; i < 2; ++i) {
			data.dh[i] = firstPass.skillPositions[i].get('downhill') || 0;
			firstPass.skillPositions[i].delete('downhill');
			data.sk[i] = new Map(firstPass.skillPositions[i]); firstPass.skillPositions[i].clear();
			nspurt[i] += +(solvers[i].isLastSpurt && solvers[i].lastSpurtTransition == -1);
		}
		// Opponent activation histories are only retained during the median replay;
		// discard these first-pass records after every sample.
		for (let i = 2; i < firstPass.skillPositions.length; ++i) firstPass.skillPositions[i].clear();
		const result = basinn ?? 0;
		diff.push(result); indexedResults.push({value: result, index: sample});
		accumulateMonteCarloRun(monteCarlo, data, course.distance, -result * 2.5);
		if (result < 0) ++wins[0];
		else if (result > 0) ++wins[1];
		else ++ties;
		const finishTimes = interpolatedFinishTimes.map((time, index) => time ?? solvers[index].accumulatetime.t);
		const firstFinishTime = Math.min(...finishTimes);
		const firstFinishers = finishTimes.reduce((count, time) => count + +(Math.abs(time - firstFinishTime) < 1e-9), 0);
		if (firstFinishers > 1) ++fieldTies;
		else if (finishTimes[0] == firstFinishTime) ++fieldWins[0];
		else if (finishTimes[1] == firstFinishTime) ++fieldWins[1];
		if (result < min) { min = result; minrun = data; minrunIndex = sample; }
		if (result > max) { max = result; maxrun = data; maxrunIndex = sample; }
		options.onProgress?.(sample + 1, nsamples * 2);
	}
	const rawResults = diff.slice();
	const orderedRuns = indexedResults.slice().sort((x,y) => x.value - y.value || x.index - y.index);
	const mean = rawResults.reduce((sum,value) => sum + value, 0) / rawResults.length;
	const meanRecord = indexedResults.reduce((best,current) =>
		Math.abs(current.value - mean) < Math.abs(best.value - mean) ? current : best);
	const mid = Math.floor(orderedRuns.length / 2);
	const medianRecord = orderedRuns.length % 2 == 0 ? orderedRuns[mid - 1] : orderedRuns[mid];
	const replayTargets = new Set<number>();
	if (meanRecord.index == minrunIndex) meanrun = minrun;
	else if (meanRecord.index == maxrunIndex) meanrun = maxrun;
	else replayTargets.add(meanRecord.index);
	// Always replay the median sample. The first pass intentionally stores only
	// the two compared runners; the replay pass captures all field trajectories
	// for the interactive race viewer without retaining every Monte Carlo run.
	replayTargets.add(medianRecord.index);

	if (!options.skipReplay && replayTargets.size > 0) {
		const replayPass = createPass();
		const replayed = new Map<number, any>();
		for (let sample = 0; sample < nsamples && replayed.size < replayTargets.size; ++sample) {
			const record = replayTargets.has(sample);
			const recordField = sample == medianRecord.index;
			const solvers = replayPass.generators.map(generator => generator.next().value as RaceSolver);
			replayPass.setActiveSolvers(solvers);
			replayPass.initializeLanes(solvers);
			const data: any = {t: [[], []], p: [[], []], v: [[], []], hp: [[], []], sk: [null, null], sdly: [0, 0], dh: [0, 0]};
			if (recordField) {
				data.fieldReplay = createFieldReplay(horses, course.distance, DT);
				recordFieldReplayFrame(data.fieldReplay, solvers, 0, course.distance, !!options.simulateLanes);
			}
			while (solvers.some(solver => solver.pos < course.distance)) {
				updateLongitudinalFieldState(solvers, DT, !!options.simulateLanes);
				for (let i = 0; i < solvers.length; ++i) {
					const solver = solvers[i];
					if (solver.pos >= course.distance) continue;
					solver.step(DT);
					if (record && i < 2) recordFrame(data, i, solver);
				}
				if (recordField) recordFieldReplayFrame(data.fieldReplay, solvers,
					data.fieldReplay.t.length * DT, course.distance, !!options.simulateLanes);
			}
			if (record) {
				data.sdly[0] = solvers[0].startDelay;
				data.sdly[1] = solvers[1].startDelay;
			}
			solvers.forEach(solver => solver.cleanup());
			for (let i = 0; i < replayPass.skillPositions.length; ++i) {
				const skillPositions = replayPass.skillPositions[i];
				if (record && i < 2) {
					data.dh[i] = skillPositions.get('downhill') || 0;
				}
				skillPositions.delete('downhill');
				if (record && i < 2) data.sk[i] = new Map(skillPositions);
				if (recordField) {
					data.fieldReplay.runners[i].skillActivations = Array.from(skillPositions,
						([id, records]: [string, any[]]) => records.map(record => ({
							id, startPosition: record[0], endPosition: record[1],
							startTime: record[2], endTime: record[3]
						}))).flat().sort((a,b) => a.startTime - b.startTime);
				}
				skillPositions.clear();
			}
			if (record) replayed.set(sample, data);
			options.onProgress?.(nsamples + sample + 1, nsamples * 2);
		}
		if (meanrun == null) meanrun = replayed.get(meanRecord.index);
		medianrun = replayed.get(medianRecord.index);
	}
	options.onProgress?.(nsamples * 2, nsamples * 2);
	diff.sort((a, b) => a - b);
	return {results: diff, rawResults, runData: {nspurt, minrun, maxrun, meanrun, medianrun,
		winRate: {wins, ties, total: nsamples}, fieldWinRate: {wins: fieldWins, ties: fieldTies, total: nsamples},
		monteCarlo: summarizeMonteCarlo(monteCarlo),
			experimental: {rankAwareField: true, fieldSize, simulateLanes: !!options.simulateLanes,
			limitations: [!options.simulateLanes && 'lateral lanes', 'physical blocking slowdown', 'ally/character-specific targets'].filter(Boolean)}}};
}
