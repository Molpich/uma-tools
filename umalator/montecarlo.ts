export const TRAJECTORY_DT = 1 / 15;

export interface ActivationEvent {
	position: number
	time: number
}

interface SkillAccumulator {
	activatedRuns: number
	events: ActivationEvent[]
}

export interface MonteCarloAccumulator {
	dt: number
	distanceStep: number
	courseDistance: number
	runs: number
	positionSums: [number[], number[]]
	velocitySums: [number[], number[]]
	leadSamples: number[][]
	distanceLeadSamples: number[][]
	skills: [Map<string, SkillAccumulator>, Map<string, SkillAccumulator>]
}

export function createMonteCarloAccumulator(skillIds: [Iterable<string>, Iterable<string>], dt = TRAJECTORY_DT, distanceStep = 10): MonteCarloAccumulator {
	const makeSkills = (ids: Iterable<string>) => new Map(Array.from(new Set(ids), id => [id, {activatedRuns: 0, events: []}]));
	return {
		dt,
		distanceStep,
		courseDistance: 0,
		runs: 0,
		positionSums: [[], []],
		velocitySums: [[], []],
		leadSamples: [],
		distanceLeadSamples: [],
		skills: [makeSkills(skillIds[0]), makeSkills(skillIds[1])]
	};
}

function resampleLeadByProgress(progress: number[], lead: number[], target: number, cursor: {value: number}) {
	if (target <= 0 || progress.length == 0) return 0;
	const last = progress.length - 1;
	if (target >= progress[last]) return lead[last];
	while (cursor.value < last && progress[cursor.value] < target) ++cursor.value;
	const hi = cursor.value;
	let lo = Math.max(0, hi - 1);
	while (lo > 0 && progress[lo] == progress[hi]) --lo;
	if (progress[hi] == progress[lo]) return lead[hi];
	const ratio = (target - progress[lo]) / (progress[hi] - progress[lo]);
	return lead[lo] + ratio * (lead[hi] - lead[lo]);
}

export function resamplePosition(times: number[], positions: number[], distance: number, time: number, cursor: {value: number}) {
	if (time <= 0 || times.length == 0) return 0;
	const last = times.length - 1;
	if (time >= times[last]) return distance;
	while (cursor.value < last && times[cursor.value] < time) ++cursor.value;
	const hi = cursor.value;
	if (times[hi] == time) return Math.min(positions[hi], distance);
	const loTime = hi == 0 ? 0 : times[hi - 1];
	const loPos = hi == 0 ? 0 : positions[hi - 1];
	const ratio = (time - loTime) / (times[hi] - loTime);
	return Math.min(loPos + ratio * (positions[hi] - loPos), distance);
}

function resampleVelocity(times: number[], velocities: number[], time: number, cursor: {value: number}) {
	if (time <= 0 || times.length == 0 || velocities.length == 0) return 0;
	const last = Math.min(times.length, velocities.length) - 1;
	if (time > times[last]) return 0;
	while (cursor.value < last && times[cursor.value] < time) ++cursor.value;
	const hi = cursor.value;
	if (times[hi] == time) return velocities[hi];
	const loTime = hi == 0 ? 0 : times[hi - 1];
	const loVelocity = hi == 0 ? 0 : velocities[hi - 1];
	const ratio = (time - loTime) / (times[hi] - loTime);
	return loVelocity + ratio * (velocities[hi] - loVelocity);
}

export function accumulateMonteCarloRun(acc: MonteCarloAccumulator, data, distance: number, interpolatedFinishLead?: number) {
	acc.courseDistance = distance;
	const finishTime = Math.max(data.t[0][data.t[0].length - 1], data.t[1][data.t[1].length - 1]);
	const needed = Math.floor(finishTime / acc.dt + 1e-9) + 1;
	while (acc.leadSamples.length < needed) {
		acc.positionSums[0].push(distance * acc.runs);
		acc.positionSums[1].push(distance * acc.runs);
		acc.velocitySums[0].push(0);
		acc.velocitySums[1].push(0);
		acc.leadSamples.push(Array(acc.runs).fill(0));
	}

	const cursors = [{value: 0}, {value: 0}];
	const velocityCursors = [{value: 0}, {value: 0}];
	for (let i = 0; i < acc.leadSamples.length; ++i) {
		const time = i * acc.dt;
		const p0 = i < needed ? resamplePosition(data.t[0], data.p[0], distance, time, cursors[0]) : distance;
		const p1 = i < needed ? resamplePosition(data.t[1], data.p[1], distance, time, cursors[1]) : distance;
		const v0 = i < needed ? resampleVelocity(data.t[0], data.v[0], time, velocityCursors[0]) : 0;
		const v1 = i < needed ? resampleVelocity(data.t[1], data.v[1], time, velocityCursors[1]) : 0;
		acc.positionSums[0][i] += p0;
		acc.positionSums[1][i] += p1;
		acc.velocitySums[0][i] += v0;
		acc.velocitySums[1][i] += v1;
		acc.leadSamples[i].push(p0 - p1);
	}

	const distancePointCount = Math.ceil(distance / acc.distanceStep) + 1;
	while (acc.distanceLeadSamples.length < distancePointCount) acc.distanceLeadSamples.push([]);
	const progress = [], lead = [];
	const progressCursors = [{value: 0}, {value: 0}];
	for (let i = 0; i < needed; ++i) {
		const time = i * acc.dt;
		const p0 = resamplePosition(data.t[0], data.p[0], distance, time, progressCursors[0]);
		const p1 = resamplePosition(data.t[1], data.p[1], distance, time, progressCursors[1]);
		// A distance-indexed lead is defined at the frontmost runner's position.
		// Stop at the first finish, otherwise the slower runner would eventually
		// catch up at the finish line and force this graph back to zero.
		progress.push(Math.max(p0, p1));
		lead.push(p0 - p1);
		if (p0 >= distance || p1 >= distance) break;
	}
	if (interpolatedFinishLead != null && progress.length > 0) {
		// Mechanics and trajectory samples remain at 15 Hz, but make the spatial
		// graph's endpoint agree with the interpolated finish result.
		progress[progress.length - 1] = distance;
		lead[lead.length - 1] = interpolatedFinishLead;
	}
	const distanceCursor = {value: 0};
	acc.distanceLeadSamples.forEach((samples, i) => {
		const target = Math.min(i * acc.distanceStep, distance);
		samples.push(resampleLeadByProgress(progress, lead, target, distanceCursor));
	});

	for (let uma = 0; uma < 2; ++uma) {
		acc.skills[uma].forEach((stats, id) => {
			const records = data.sk[uma].get(id) || [];
			if (records.length > 0) ++stats.activatedRuns;
			records.forEach(record => stats.events.push({position: record[0], time: record[2]}));
		});
	}
	++acc.runs;
}

export function quantileSorted(sorted: number[], q: number) {
	if (sorted.length == 0) return null;
	const index = (sorted.length - 1) * q;
	const lo = Math.floor(index), hi = Math.ceil(index);
	return lo == hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

function distribution(values: number[]) {
	if (values.length == 0) return null;
	const sorted = values.slice().sort((a,b) => a - b);
	return {
		p10: quantileSorted(sorted, 0.10),
		p25: quantileSorted(sorted, 0.25),
		median: quantileSorted(sorted, 0.50),
		p75: quantileSorted(sorted, 0.75),
		p90: quantileSorted(sorted, 0.90)
	};
}

export function summarizeMonteCarlo(acc: MonteCarloAccumulator) {
	const time = acc.positionSums[0].map((_,i) => i * acc.dt);
	const meanPosition = acc.positionSums.map(sums => sums.map(sum => sum / acc.runs)) as [number[], number[]];
	const meanVelocity = acc.velocitySums.map(sums => sums.map(sum => sum / acc.runs)) as [number[], number[]];
	let identityMaxError = 0;
	const lead = acc.leadSamples.map((samples,i) => {
		const sorted = samples.slice().sort((a,b) => a - b);
		const mean = samples.reduce((sum,x) => sum + x, 0) / samples.length;
		identityMaxError = Math.max(identityMaxError, Math.abs(mean - (meanPosition[0][i] - meanPosition[1][i])));
		return {
			mean,
			p10: quantileSorted(sorted, 0.10),
			p25: quantileSorted(sorted, 0.25),
			median: quantileSorted(sorted, 0.50),
			p75: quantileSorted(sorted, 0.75),
			p90: quantileSorted(sorted, 0.90)
		};
	});
	const distance = acc.distanceLeadSamples.map((_, i) => Math.min(i * acc.distanceStep, acc.courseDistance));
	const leadByDistance = acc.distanceLeadSamples.map(samples => {
		const sorted = samples.slice().sort((a,b) => a - b);
		return {
			mean: samples.reduce((sum,x) => sum + x, 0) / samples.length,
			p10: quantileSorted(sorted, 0.10), p25: quantileSorted(sorted, 0.25),
			median: quantileSorted(sorted, 0.50), p75: quantileSorted(sorted, 0.75),
			p90: quantileSorted(sorted, 0.90)
		};
	});
	const skillActivations = acc.skills.map(skills => Array.from(skills, ([id,stats]) => ({
		id,
		activationRate: stats.activatedRuns / acc.runs,
		activatedRuns: stats.activatedRuns,
		neverActivated: acc.runs - stats.activatedRuns,
		eventCount: stats.events.length,
		position: distribution(stats.events.map(e => e.position)),
		time: distribution(stats.events.map(e => e.time))
	}))) as [any[], any[]];
	return {dt: acc.dt, runs: acc.runs, time, distance, meanPosition, meanVelocity, lead, leadByDistance, skillActivations, identityMaxError};
}
