import { CourseData } from '../uma-skill-tools/CourseData';
import { Region, RegionList } from '../uma-skill-tools/Region';
import { RaceParameters } from '../uma-skill-tools/RaceParameters';
import { RaceSolver } from '../uma-skill-tools/RaceSolver';
import { RaceSolverBuilder, Perspective } from '../uma-skill-tools/RaceSolverBuilder';
import type { GameHpPolicy } from '../uma-skill-tools/HpPolicy';
import { Rule30CARng } from '../uma-skill-tools/Random';
import { ActivationSamplePolicy, ImmediatePolicy, RandomPolicy, LogNormalRandomPolicy, ErlangRandomPolicy, StraightRandomPolicy, AllCornerRandomPolicy } from '../uma-skill-tools/ActivationSamplePolicy';

import { HorseState, SamplePolicyDesc, uniqueSkillForUma } from '../components/HorseDefTypes';

import skillmeta from '../skill_meta.json';
import { accumulateMonteCarloRun, createMonteCarloAccumulator, summarizeMonteCarlo } from './montecarlo';

class FixedDistancePolicy {
	constructor(readonly pos: number) {}
	sample(_0: RegionList, nsamples: number, _1: PRNG) { return Array.from({length: nsamples}, _ => new Region(this.pos, this.pos + 10)); }

	// these should never be called because this policy is only used as an override and never reconciled with anything
	reconcile(other: ActivationSamplePolicy) { console.assert(false); }
	reconcileImmediate(other: ActivationSamplePolicy) { console.assert(false); }
	reconcileDistributionRandom(other: ActivationSamplePolicy) { console.assert(false); }
	reconcileRandom(other: ActivationSamplePolicy) { console.assert(false); }
	reconcileStraightRandom(other: ActivationSamplePolicy) { console.assert(false); }
	reconcileAllCornerRandom(other: ActivationSamplePolicy) { console.assert(false); }
}

export function instantiateSamplePolicy(desc: SamplePolicyDesc | undefined): ActivationSamplePolicy | undefined {
	if (desc == null) return undefined;
	switch (desc.policy) {
		case 'immediate': return ImmediatePolicy;
		case 'random': return RandomPolicy;
		case 'straight-random': return StraightRandomPolicy;
		case 'all-corner-random': return AllCornerRandomPolicy;
		case 'log-normal': return new LogNormalRandomPolicy(desc.mu, desc.sigma);
		case 'erlang': return new ErlangRandomPolicy(desc.k, desc.lambda);
		case 'fixed': return new FixedDistancePolicy(desc.pos);
	}
}

export function getActivator(selfSet: Map<string, [number,number]>, otherSet: Map<String, [number,number]> | null) {
	return function (s, id, persp) {
		const skillSet = persp == Perspective.Self ? selfSet : otherSet;
		if (id == 'downhill') {
			if (!skillSet.has('downhill')) skillSet.set('downhill', 0);
			skillSet.set('downhill', skillSet.get('downhill') - s.accumulatetime.t);
		} else if (skillSet != null && id != 'asitame' && id != 'staminasyoubu') {
			if (!skillSet.has(id)) skillSet.set(id, []);
			skillSet.get(id).push([s.pos, -1, s.accumulatetime.t, -1]);
		}
	};
}
export function getDeactivator(selfSet: Map<string, [number,number]>, otherSet: Map<String, [number,number]> | null, course) {
	return function (s, id, persp) {
		const skillSet = persp == Perspective.Self ? selfSet : otherSet;
		if (id == 'downhill') {
			skillSet.set('downhill', skillSet.get('downhill') + s.accumulatetime.t);
		} else if (skillSet != null && id != 'asitame' && id != 'staminasyoubu') {
			const ar = skillSet.get(id);  // activation record
			// in the case of adding multiple copies of speed debuffs a skill can activate again before the first
			// activation has finished (as each copy has the same ID), so we can't just access a specific index
			// (-1).
			// assume that multiple activations of a skill always deactivate in the same order (probably true?) so
			// just seach for the first record that hasn't had its deactivation location filled out yet.
			const r = ar.find(x => x[1] == -1);
			// onSkillDeactivate gets called twice for skills that have both speed and accel components, so the end
			// position could already have been filled out and r will be undefined
			if (r != null) {
				r[1] = Math.min(s.pos, course.distance);
				r[3] = s.accumulatetime.t;
			}
		}
	};
}

export function runComparison(nsamples: number, course: CourseData, racedef: RaceParameters, uma1: HorseState, uma2: HorseState, seed: [number,number], options) {
	const standard = new RaceSolverBuilder(nsamples)
		.seed(...seed)
		.course(course)
		.ground(racedef.groundCondition)
		.weather(racedef.weather)
		.season(racedef.season)
		.time(racedef.time);
	if (racedef.orderRange != null) {
		standard
			.order(racedef.orderRange[0], racedef.orderRange[1])
			.numUmas(racedef.numUmas);
	}
	const compare = standard.fork();
	standard.horse(uma1).otherHorse(uma2);
	compare.horse(uma2).otherHorse(uma1);
	const wisdomSeeds = new Map<string, [number,number]>();
	const wisdomRng = new Rule30CARng(...seed);
	for (let i = 0; i < 20; ++i) wisdomRng.pair();   // advance the RNG state a bit because we only seeded the low bits
	// ensure skills common to the two umas are added in the same order regardless of what additional skills they have
	// this is important to make sure the rng for their activations is synced
	// sort first by groupId so that white and gold versions of a skill get added in the same order
	const common = Array.from(new Set(uma1.skills.keys()).intersection(new Set(uma2.skills.keys()))).sort((a,b) => +a - +b);
	const commonIdx = (id) => { let i = common.indexOf(skillmeta[id].groupId); return i > -1 ? i : common.length; };
	const sort = (a,b) => commonIdx(a) - commonIdx(b) || +a - +b;
	const u1id = uniqueSkillForUma(uma1.outfitId, uma1.starCount);
	const u2id = uniqueSkillForUma(uma2.outfitId, uma2.starCount);
	Array.from(uma1.skills.values()).sort(sort).forEach(id => {
		wisdomSeeds.set(id, wisdomRng.pair());
		standard.addSkill(id, Perspective.Self, id == u1id ? uma1.uniqueLv : 1, instantiateSamplePolicy(uma1.samplePolicies.get(id)));
	});
	Array.from(uma2.skills.values()).sort(sort).forEach(id => {
		// this means that the second set of rolls 'wins' for skills on both, but this doesn't actually matter
		wisdomSeeds.set(id, wisdomRng.pair());
		compare.addSkill(id, Perspective.Self, id == u2id ? uma2.uniqueLv : 1, instantiateSamplePolicy(uma2.samplePolicies.get(id)));
	});
	// iterating twice like this is VERY ANNOYING
	// unfortunately, because we add every skill to both umas, if we add them in the same iteration uma2 will have all the
	// Other skills before its Self skills, which can cause skill desync issues when there are debuffs
	// TODO i don't really like this, this might just be masking some deeper underlying issue.
	uma1.skills.forEach(id => compare.addSkill(id, Perspective.Other, id == u1id ? uma1.uniqueLv : 1, instantiateSamplePolicy(uma1.samplePolicies.get(id))));
	uma2.skills.forEach(id => standard.addSkill(id, Perspective.Other, id == u2id ? uma2.uniqueLv : 1, instantiateSamplePolicy(uma2.samplePolicies.get(id))));
	if (options.pairSkillRngByGroup) {
		const sampleGroups = new Map<string,string>();
		Array.from(uma1.skills.values()).concat(Array.from(uma2.skills.values()))
			.forEach(id => sampleGroups.set(id, skillmeta[id].groupId));
		standard.withIndependentSkillSamples(sampleGroups);
		compare.withIndependentSkillSamples(sampleGroups);
	}
	standard.withAsiwotameru();
	compare.withAsiwotameru();
	if (!CC_GLOBAL) {
		standard.withStaminaSyoubu();
		compare.withStaminaSyoubu();
	}
	if (options.usePosKeep) {
		standard.useDefaultPacer(); compare.useDefaultPacer();
	}
	if (options.useCompeteTop) {
		standard.withItidoriarasoi(); compare.withItidoriarasoi();
	}
	if (options.useIntChecks) {
		standard.withWisdomChecks(wisdomSeeds);
		compare.withWisdomChecks(wisdomSeeds);
	}
	// Keep pristine configured builders for the representative-run replay. A
	// builder's RNG state is consumed by build(), so the second pass must use
	// clones made before the first pass begins.
	const replayStandard = standard.fork();
	const replayCompare = compare.fork();
	const skillPos1 = new Map(), skillPos2 = new Map();
	standard.onSkillActivate(getActivator(skillPos1, null));
	standard.onSkillDeactivate(getDeactivator(skillPos1, null, course));
	compare.onSkillActivate(getActivator(skillPos2, null));
	compare.onSkillDeactivate(getDeactivator(skillPos2, null, course));
	let a = standard.build(), b = compare.build();
	let ai = 1, bi = 0;
	let sign = 1;
	const diff = [];
	const indexedResults: {value: number, index: number}[] = [];
	let min = Infinity, max = -Infinity;
	let minrun, maxrun, meanrun, medianrun;
	let minrunIndex = -1, maxrunIndex = -1;
	let nspurt = [0,0];
	const wins = [0, 0], fieldWins = [0, 0];
	let ties = 0, fieldTies = 0;
	const monteCarlo = createMonteCarloAccumulator([uma1.skills.values(), uma2.skills.values()]);
	let retry = false;
	for (let i = 0; i < nsamples; ++i) {
		const s1 = a.next(retry).value as RaceSolver;
		const s2 = b.next(retry).value as RaceSolver;
		const data = {t: [[], []], p: [[], []], v: [[], []], hp: [[], []], sk: [null,null], sdly: [0,0], dh: [0,0]};

		while (s2.pos < course.distance) {
			s2.step(1/15);
			data.t[ai].push(s2.accumulatetime.t);
			data.p[ai].push(s2.pos);
			data.v[ai].push(s2.currentSpeed + (s2.modifiers.currentSpeed.acc + s2.modifiers.currentSpeed.err));
			data.hp[ai].push((s2.hp as GameHpPolicy).hp);
		}
		data.sdly[ai] = s2.startDelay;

		while (s1.accumulatetime.t < s2.accumulatetime.t) {
			s1.step(1/15);
			data.t[bi].push(s1.accumulatetime.t);
			data.p[bi].push(s1.pos);
			data.v[bi].push(s1.currentSpeed + (s1.modifiers.currentSpeed.acc + s1.modifiers.currentSpeed.err));
			data.hp[bi].push((s1.hp as GameHpPolicy).hp);
		}
		// run the rest of the way to have data for the chart
		const pos1 = s1.pos;
		while (s1.pos < course.distance) {
			s1.step(1/15);
			data.t[bi].push(s1.accumulatetime.t);
			data.p[bi].push(s1.pos);
			data.v[bi].push(s1.currentSpeed + (s1.modifiers.currentSpeed.acc + s1.modifiers.currentSpeed.err));
			data.hp[bi].push((s1.hp as GameHpPolicy).hp);
		}
		data.sdly[bi] = s1.startDelay;

		s2.cleanup();
		s1.cleanup();

		data.dh[1] = skillPos2.get('downhill') || 0; skillPos2.delete('downhill');
		data.dh[0] = skillPos1.get('downhill') || 0; skillPos1.delete('downhill');
		data.sk[1] = new Map(skillPos2);  // NOT ai (NB. why not?)
		skillPos2.clear();
		data.sk[0] = new Map(skillPos1);  // NOT bi (NB. why not?)
		skillPos1.clear();

		// if `standard` is faster than `compare` then the former ends up going past the course distance
		// this is not in itself a problem, but it would overestimate the difference if for example a skill
		// continues past the end of the course. i feel like there are probably some other situations where it would
		// be inaccurate also. if this happens we have to swap them around and run it again.
		if (s2.pos < pos1 || isNaN(pos1)) {
			[b,a] = [a,b];
			[bi,ai] = [ai,bi];
			sign *= -1;
			--i;  // this one didnt count
			retry = true;
		} else {
			retry = false;
			accumulateMonteCarloRun(monteCarlo, data, course.distance);
			nspurt[bi] += +(s1.isLastSpurt && s1.lastSpurtTransition == -1);
			nspurt[ai] += +(s2.isLastSpurt && s2.lastSpurtTransition == -1);
			const basinn = sign * (s2.pos - pos1) / 2.5;
			const acceptedIndex = diff.length;
			diff.push(basinn);
			indexedResults.push({value: basinn, index: acceptedIndex});
			if (basinn < 0) ++wins[0];
			else if (basinn > 0) ++wins[1];
			else ++ties;
			// In the two-runner legacy path, the field winner is the same as the
			// head-to-head winner (and this remains correct across retry swaps).
			if (basinn < 0) ++fieldWins[0];
			else if (basinn > 0) ++fieldWins[1];
			else ++fieldTies;
			if (basinn < min) {
				min = basinn;
				minrun = data;
				minrunIndex = acceptedIndex;
			}
			if (basinn > max) {
				max = basinn;
				maxrun = data;
				maxrunIndex = acceptedIndex;
			}
			options.onProgress?.(acceptedIndex + 1, nsamples * 2);
		}
	}
	const rawResults = diff.slice();
	const orderedRuns = indexedResults.slice().sort((x,y) => x.value - y.value || x.index - y.index);
	const mean = rawResults.reduce((sum,value) => sum + value, 0) / rawResults.length;
	const meanRecord = indexedResults.reduce((best,current) =>
		Math.abs(current.value - mean) < Math.abs(best.value - mean) ? current : best);
	const mid = Math.floor(orderedRuns.length / 2);
	// For an even sample count the mathematical median is between two actual
	// runs. Use the lower-middle run (for 500 samples, the 250th sorted run) as
	// the concrete trajectory shown by the UI.
	const medianRecord = orderedRuns.length % 2 == 0 ? orderedRuns[mid - 1] : orderedRuns[mid];

	const replayTargets = new Set<number>();
	if (meanRecord.index == minrunIndex) meanrun = minrun;
	else if (meanRecord.index == maxrunIndex) meanrun = maxrun;
	else replayTargets.add(meanRecord.index);
	if (medianRecord.index == minrunIndex) medianrun = minrun;
	else if (medianRecord.index == maxrunIndex) medianrun = maxrun;
	else replayTargets.add(medianRecord.index);

	if (replayTargets.size > 0) {
		const replaySkillPos1 = new Map(), replaySkillPos2 = new Map();
		replayStandard.onSkillActivate(getActivator(replaySkillPos1, null));
		replayStandard.onSkillDeactivate(getDeactivator(replaySkillPos1, null, course));
		replayCompare.onSkillActivate(getActivator(replaySkillPos2, null));
		replayCompare.onSkillDeactivate(getDeactivator(replaySkillPos2, null, course));
		let replayA = replayStandard.build(), replayB = replayCompare.build();
		let replayAi = 1, replayBi = 0;
		let replayRetry = false;
		const replayed = new Map<number, any>();
		for (let i = 0; i < nsamples && replayed.size < replayTargets.size; ++i) {
			const record = replayTargets.has(i);
			const s1 = replayA.next(replayRetry).value as RaceSolver;
			const s2 = replayB.next(replayRetry).value as RaceSolver;
			const data = {t: [[], []], p: [[], []], v: [[], []], hp: [[], []], sk: [null,null], sdly: [0,0], dh: [0,0]};
			while (s2.pos < course.distance) {
				s2.step(1/15);
				if (record) {
					data.t[replayAi].push(s2.accumulatetime.t);
					data.p[replayAi].push(s2.pos);
					data.v[replayAi].push(s2.currentSpeed + s2.modifiers.currentSpeed.acc + s2.modifiers.currentSpeed.err);
					data.hp[replayAi].push((s2.hp as GameHpPolicy).hp);
				}
			}
			if (record) data.sdly[replayAi] = s2.startDelay;
			while (s1.accumulatetime.t < s2.accumulatetime.t) {
				s1.step(1/15);
				if (record) {
					data.t[replayBi].push(s1.accumulatetime.t);
					data.p[replayBi].push(s1.pos);
					data.v[replayBi].push(s1.currentSpeed + s1.modifiers.currentSpeed.acc + s1.modifiers.currentSpeed.err);
					data.hp[replayBi].push((s1.hp as GameHpPolicy).hp);
				}
			}
			const pos1 = s1.pos;
			while (s1.pos < course.distance) {
				s1.step(1/15);
				if (record) {
					data.t[replayBi].push(s1.accumulatetime.t);
					data.p[replayBi].push(s1.pos);
					data.v[replayBi].push(s1.currentSpeed + s1.modifiers.currentSpeed.acc + s1.modifiers.currentSpeed.err);
					data.hp[replayBi].push((s1.hp as GameHpPolicy).hp);
				}
			}
			if (record) data.sdly[replayBi] = s1.startDelay;
			s2.cleanup();
			s1.cleanup();
			if (record) {
				data.dh[1] = replaySkillPos2.get('downhill') || 0;
				data.dh[0] = replaySkillPos1.get('downhill') || 0;
			}
			replaySkillPos2.delete('downhill');
			replaySkillPos1.delete('downhill');
			if (record) {
				data.sk[1] = new Map(replaySkillPos2);
				data.sk[0] = new Map(replaySkillPos1);
			}
			replaySkillPos2.clear();
			replaySkillPos1.clear();
			if (s2.pos < pos1 || isNaN(pos1)) {
				[replayB,replayA] = [replayA,replayB];
				[replayBi,replayAi] = [replayAi,replayBi];
				--i;
				replayRetry = true;
			} else {
				replayRetry = false;
				if (record) replayed.set(i, data);
				options.onProgress?.(nsamples + i + 1, nsamples * 2);
			}
		}
		if (meanrun == null) meanrun = replayed.get(meanRecord.index);
		if (medianrun == null) medianrun = replayed.get(medianRecord.index);
	}
	options.onProgress?.(nsamples * 2, nsamples * 2);
	diff.sort((a,b) => a - b);
	return {results: diff, rawResults, runData: {
		nspurt, minrun, maxrun, meanrun, medianrun,
		winRate: {wins, ties, total: nsamples},
		fieldWinRate: {wins: fieldWins, ties: fieldTies, total: nsamples},
		monteCarlo: summarizeMonteCarlo(monteCarlo)
	}};
}
