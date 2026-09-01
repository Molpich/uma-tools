import type { CourseData } from '../uma-skill-tools/CourseData';
import type { RaceParameters } from '../uma-skill-tools/RaceParameters';
import { FieldConditions } from '../uma-skill-tools/ActivationConditions';
import { AllCornerRandomPolicy, RandomPolicy, StraightRandomPolicy } from '../uma-skill-tools/ActivationSamplePolicy';
import { getParser } from '../uma-skill-tools/ConditionParser';
import { Region, RegionList } from '../uma-skill-tools/Region';
import { Rule30CARng } from '../uma-skill-tools/Random';
import { SkillType } from '../uma-skill-tools/RaceSolver';
import { buildBaseStats, buildSkillData, Perspective } from '../uma-skill-tools/RaceSolverBuilder';

import { HorseState } from '../components/HorseDefTypes';
import { DEFAULT_MIN_SAMPLES, minimumAdaptiveSamples } from './AdaptiveSampling';
import { runComparison } from './compare';
import { runRankAwareComparison } from './fullfield';
import { runHpCalc } from './hpcalc';
import { buildUmaTableBaseline, buildUmaTableCandidate, UmaTableCandidate } from './uma-table';

import skillmeta from '../skill_meta.json';

function mergeResults(results1, results2) {
	console.assert(results1.id == results2.id, `mergeResults: ${results1.id} != ${results2.id}`);
	const n1 = results1.results.length, n2 = results2.results.length;
	const combinedResults = results1.results.concat(results2.results).sort((a,b) => a - b);
	const combinedMean = (results1.mean * n1 + results2.mean * n2) / (n1 + n2);
	const mid = Math.floor(combinedResults.length / 2);
	const newMedian = combinedResults.length % 2 == 0 ? (combinedResults[mid-1] + combinedResults[mid]) / 2 : combinedResults[mid];
	return {
		id: results1.id,
		results: combinedResults,
		min: Math.min(results1.min, results2.min),
		max: Math.max(results1.max, results2.max),
		mean: combinedMean,
		median: newMedian,
		runData: {
			// TODO should re-compute the bashin gain from .t/.p and pick whichever is closer to new mean/median
			...(n2 > n1 ? results2.runData : results1.runData),
			minrun: results1.min < results2.min ? results1.runData.minrun : results2.runData.minrun,
			maxrun: results1.max > results2.max ? results1.runData.maxrun : results2.runData.maxrun,
		}
	};
}

function mergeResultSets(data1, data2) {
	data2.forEach((r,id) => {
		data1.set(id, mergeResults(data1.get(id), r));
	});
}

// Full-field rows are evaluated progressively. Low-variance rows can stop at
// 5; variable rows continue in batches until their mean and variance stabilize
// or they reach the 50-sample cap.
const FULL_FIELD_SAMPLE_STEPS = [5, 5, 10, 10, 20];
const FULL_FIELD_MAX_SAMPLES = FULL_FIELD_SAMPLE_STEPS.reduce((sum, n) => sum + n, 0);
const FULL_FIELD_LOW_VARIANCE = 0.0025; // (0.05 lengths standard deviation)^2
const FULL_FIELD_LOW_RELATIVE_VARIANCE = 0.0225; // (15% coefficient of variation)^2
const FULL_FIELD_RELATIVE_VARIANCE_MIN_MEAN = 0.25; // avoid unstable division for effects near zero
const FULL_FIELD_STABLE_MEAN_DELTA = 0.05; // lengths
const FULL_FIELD_STABLE_VARIANCE_DELTA = 0.0025;
const FULL_FIELD_STABLE_VARIANCE_RATIO = 0.15;
const FULL_FIELD_MEAN_CI_ABSOLUTE = 0.10; // lengths
const FULL_FIELD_MEAN_CI_RELATIVE = 0.15;

function isTrueRandomPolicy(policy) {
	return policy === RandomPolicy || policy === StraightRandomPolicy || policy === AllCornerRandomPolicy;
}

function minimumSamplesForSkill(id: string, course: CourseData, racedef: RaceParameters,
	uma: HorseState, rankAwareField: boolean) {
	try {
		const horse = buildBaseStats(uma, racedef.mood);
		const wholeCourse = new RegionList(new Region(0, course.distance));
		const parser = getParser(rankAwareField ? FieldConditions : undefined);
		const triggers = buildSkillData(horse, racedef, course, wholeCourse, parser,
			id, Perspective.Self, 1, false, horse);
		const randomTriggers = triggers.filter(trigger => isTrueRandomPolicy(trigger.samplePolicy));
		if (randomTriggers.length == 0) return DEFAULT_MIN_SAMPLES;
		const allEffects = triggers.flatMap(trigger => trigger.effects);
		const accelerationOnly = allEffects.length > 0
			&& allEffects.every(effect => effect.type == SkillType.Accel || effect.type == SkillType.Noop)
			&& triggers.every(trigger => trigger.fieldEffects == null || trigger.fieldEffects.length == 0);
		const phase1StrategyCoef = [0, 0.98, 0.991, 0.998, 1.0, 0.962][horse.strategy] || 1;
		const estimatedMidRaceSpeed = (20 - (course.distance - 2000) / 1000) * phase1StrategyCoef;
		const longestAccelDuration = Math.max(0, ...allEffects
			.filter(effect => effect.type == SkillType.Accel)
			.map(effect => effect.baseDuration * course.distance / 1000));
		return minimumAdaptiveSamples({
			isRandom: true,
			isAccelerationOnly: accelerationOnly,
			regions: randomTriggers.flatMap(trigger => Array.from(trigger.regions)),
			courseDistance: course.distance,
			spillDistance: longestAccelDuration * estimatedMidRaceSpeed
		});
	} catch (_) {
		// Unknown or unsupported metadata must not make the table more expensive.
		return DEFAULT_MIN_SAMPLES;
	}
}

function sampleVariance(result) {
	if (result.results.length < 2) return false;
	return result.results.reduce((sum, value) => sum + (value - result.mean) ** 2, 0)
		/ (result.results.length - 1);
}

function hasHighVariance(result) {
	const variance = sampleVariance(result);
	if (variance <= FULL_FIELD_LOW_VARIANCE) return false;
	if (Math.abs(result.mean) >= FULL_FIELD_RELATIVE_VARIANCE_MIN_MEAN
		&& variance / (result.mean ** 2) <= FULL_FIELD_LOW_RELATIVE_VARIANCE) return false;
	return true;
}

function estimatesStable(previous, current) {
	const previousVariance = sampleVariance(previous), currentVariance = sampleVariance(current);
	const varianceTolerance = Math.max(FULL_FIELD_STABLE_VARIANCE_DELTA,
		Math.max(previousVariance, currentVariance) * FULL_FIELD_STABLE_VARIANCE_RATIO);
	return Math.abs(current.mean - previous.mean) <= FULL_FIELD_STABLE_MEAN_DELTA
		&& Math.abs(currentVariance - previousVariance) <= varianceTolerance;
}

function meanEstimateConverged(result) {
	const n = result.results.length;
	if (n < 10) return false;
	// Conservative 95% two-sided Student-t critical values for the adaptive
	// checkpoints (10, 20, 30, and 50 samples).
	const critical = n < 20 ? 2.262 : n < 30 ? 2.093 : n < 40 ? 2.045 : 2.010;
	const halfWidth = critical * Math.sqrt(sampleVariance(result) / n);
	const tolerance = Math.max(FULL_FIELD_MEAN_CI_ABSOLUTE,
		Math.abs(result.mean) * FULL_FIELD_MEAN_CI_RELATIVE);
	return halfWidth <= tolerance;
}

function runSkillComparison(nsamples: number, course: CourseData, racedef: RaceParameters,
	baseUma: HorseState, variantUma: HorseState, otherUma: HorseState, seed: [number,number], options) {
	const compare = options.rankAwareField ? runRankAwareComparison : runComparison;
	// Pair two otherwise identical fields: only Uma 1 changes between the
	// baseline and variant scenario. Positive values therefore mean the new
	// skill improved Uma 1's relative result against the same Uma 2/field.
	// Skill/Uma evaluation consumes aggregate results only. Avoid retaining
	// hundreds of interactive field replays for every table row; the compare
	// path explicitly leaves replay retention enabled for the user's viewer.
	const pairedOptions = {...options, pairSkillRngByGroup: true, skipReplay: options.skipReplay ?? true};
	const base = compare(nsamples, course, racedef, baseUma, otherUma, seed, pairedOptions);
	const variant = compare(nsamples, course, racedef, variantUma, otherUma, seed, pairedOptions);
	const rawResults = base.rawResults.map((baseResult, index) => baseResult - variant.rawResults[index]);
	return {results: rawResults.slice().sort((a,b) => a - b), runData: variant.runData};
}

function run1Round(nsamples: number, skills: string[], course: CourseData, racedef: RaceParameters,
	uma: HorseState, otherUma: HorseState, seed: [number,number], options, onSkillComplete?: () => void) {
	const data = new Map();
	skills.forEach(id => {
		const withSkill = {...uma, skills: new Map(uma.skills.entries())};
		withSkill.skills.set(skillmeta[id].groupId, id);
		const {results, runData} = runSkillComparison(nsamples, course, racedef, uma, withSkill, otherUma, seed, options);
		const mid = Math.floor(results.length / 2);
		const median = results.length % 2 == 0 ? (results[mid-1] + results[mid]) / 2 : results[mid];
		const mean = results.reduce((a,b) => a+b, 0) / results.length;
		data.set(id, {
			id, results, runData,
			min: results[0],
			max: results[results.length-1],
			mean,
			median
		});
		onSkillComplete?.();
	});
	return data;
}

function doChart({skills, course, racedef, uma, otherUma, options, runId = 0, workerId = 0}) {
	const seedgen = new Rule30CARng(options.seed);
	const sampleSteps = options.rankAwareField ? FULL_FIELD_SAMPLE_STEPS : [3, 17, 30, 50, 100];
	const minimumSamples = new Map(options.rankAwareField
		? skills.map(id => [id, minimumSamplesForSkill(id, course, racedef, uma, true)]) : []);
	const totalWork = skills.length * (options.rankAwareField ? FULL_FIELD_MAX_SAMPLES : sampleSteps.length);
	let completedWork = 0;
	function reportProgress(done = false) {
		postMessage({type: 'chart-progress', runId, workerId, completed: done ? totalWork : completedWork, total: totalWork, done});
	}
	function runRound(nsamples, roundSkills, seed, progressPerSkill = 1) {
		return run1Round(nsamples, roundSkills, course, racedef, uma, otherUma, seed, options, () => {
			completedWork += progressPerSkill;
			reportProgress();
		});
	}
	reportProgress();
	let results;
	if (options.rankAwareField) {
		let sampled = sampleSteps[0];
		results = runRound(sampleSteps[0], skills, seedgen.pair(), sampleSteps[0]);
		postMessage({type: 'chart', results, runId});
		let continuingSkills = skills.filter(id => sampled < minimumSamples.get(id) || hasHighVariance(results.get(id)));
		completedWork += (skills.length - continuingSkills.length) * (FULL_FIELD_MAX_SAMPLES - sampled);
		reportProgress();
		for (let i = 1; i < sampleSteps.length && continuingSkills.length > 0; ++i) {
			const step = sampleSteps[i];
			const previous = new Map(continuingSkills.map(id => [id, results.get(id)]));
			const update = runRound(step, continuingSkills, seedgen.pair(), step);
			mergeResultSets(results, update);
			sampled += step;
			postMessage({type: 'chart', results, runId});
			const nextSkills = sampled == FULL_FIELD_MAX_SAMPLES ? [] : continuingSkills.filter(id => {
				const current = results.get(id);
				if (sampled < minimumSamples.get(id)) return true;
				return hasHighVariance(current)
					&& !meanEstimateConverged(current)
					&& !estimatesStable(previous.get(id), current);
			});
			completedWork += (continuingSkills.length - nextSkills.length) * (FULL_FIELD_MAX_SAMPLES - sampled);
			reportProgress();
			continuingSkills = nextSkills;
		}
	} else {
		sampleSteps.forEach((nsamples, index) => {
			const update = runRound(nsamples, skills, seedgen.pair());
			if (index == 0) results = update;
			else mergeResultSets(results, update);
			postMessage({type: 'chart', results, runId});
		});
	}
	reportProgress(true);
}

function doUmaChart({candidates, samples = 5, course, racedef, uma, otherUma, options, runId = 0, workerId = 0}) {
	const seedgen = new Rule30CARng(options.seed);
	const total = candidates.length * samples;
	let completed = 0;
	postMessage({type: 'uma-chart-progress', runId, workerId, completed, total, done: false});
	for (const candidate of candidates as UmaTableCandidate[]) {
		try {
			const candidateUma = buildUmaTableCandidate(uma, candidate);
			const baselineUma = buildUmaTableBaseline(candidateUma);
			// Do not put the control in the candidate's field: a duplicate runner
			// changes rank-history conditions such as order_rate_out70_continue.
			// Instead run paired, otherwise identical fields against Uma 2 and the
			// configured roster. Positive values are the candidate unique's gain.
			const comparison = runSkillComparison(samples, course, racedef, baselineUma, candidateUma, otherUma, seedgen.pair(), {
				...options, rankAwareField: true, skipReplay: true
			});
			const values = comparison.results;
			const row = {
				id: candidate.outfitId, results: values,
				mean: values.reduce((sum, value) => sum + value, 0) / values.length,
				max: values[values.length - 1],
				fieldWinRate: comparison.runData.fieldWinRate.wins[0] / comparison.runData.fieldWinRate.total
			};
			// Send only the completed row. Repeatedly cloning the entire worker
			// batch creates avoidable main-thread pressure near the end of a run.
			postMessage({type: 'uma-chart', results: new Map([[candidate.outfitId, row]]), runId});
		} catch (error) {
			console.error('Uma table candidate failed:', candidate.outfitId, error);
		}
		completed += samples;
		postMessage({type: 'uma-chart-progress', runId, workerId, completed, total, done: false});
	}
	postMessage({type: 'uma-chart-progress', runId, workerId, completed: total, total, done: true});
}

function doCompare({nsamples, course, racedef, uma1, uma2, fieldUmas, options, runId}) {
	const seedgen = new Rule30CARng(options.seed);
	options = {...options, fieldUmas};
	const compare = options.rankAwareField ? runRankAwareComparison : runComparison;
	const sampleSteps = [];
	for (let n = Math.min(20, nsamples), mul = 6; n < nsamples; n = Math.min(n * mul, nsamples), mul = Math.max(mul - 1, 2)) {
		sampleSteps.push(n);
	}
	sampleSteps.push(nsamples);
	// The legacy pairwise solver has a second representative-replay pass;
	// rank-aware field runs now retain their complete replays during the first
	// pass, so their progress represents one simulation pass per sample.
	const passCount = options.rankAwareField ? 1 : 2;
	const total = sampleSteps.reduce((sum, samples) => sum + samples * passCount, 0);
	let offset = 0, lastPercent = -1, results;
	function reportProgress(completed, done = false) {
		const percent = total > 0 ? Math.floor(100 * completed / total) : 100;
		if (!done && percent == lastPercent) return;
		lastPercent = percent;
		postMessage({type: 'compare-progress', runId, completed: done ? total : completed, total, done});
	}
	reportProgress(0);
	for (const samples of sampleSteps) {
		// Only the final adaptive batch needs to carry every interactive replay.
		// Earlier progress snapshots remain lightweight and are replaced by the
		// final result before the user can select a run.
		const roundOptions = {...options,
			skipReplay: options.skipReplay || (options.rankAwareField && samples != nsamples),
			onProgress: completed => reportProgress(offset + completed)};
		results = compare(samples, course, racedef, uma1, uma2, seedgen.pair(), roundOptions);
		offset += samples * passCount;
		postMessage({type: 'compare', results, runId});
	}
	reportProgress(total, true);
}

function doHpCalc({nsamples, course, racedef, uma, debufUma, options}) {
	const seedgen = new Rule30CARng(options.seed);
	let results;
	for (let n = Math.min(20, nsamples), mul = 6; n < nsamples; n = Math.min(n * mul, nsamples), mul = Math.max(mul - 1, 2)) {
		results = runHpCalc(n, course, racedef, uma, debufUma, seedgen.pair(), options);
		postMessage({type: 'hpcalc', results});
	}
	results = runHpCalc(nsamples, course, racedef, uma, debufUma, seedgen.pair(), options);
	postMessage({type: 'hpcalc', results});
}

self.addEventListener('message', function (e) {
	const {msg, data} = e.data;
	switch (msg) {
		case 'chart':
			doChart(data);
			break;
		case 'compare':
			doCompare(data);
			break;
		case 'hpcalc':
			doHpCalc(data);
			break;
		case 'uma-chart':
			doUmaChart(data);
			break;
	}
});
