export interface SamplingRegion {
	start: number
	end: number
}

export interface RandomSkillOpportunity {
	isRandom: boolean
	isAccelerationOnly: boolean
	regions: SamplingRegion[]
	courseDistance: number
	/** Furthest distance a random acceleration effect can remain active for. */
	spillDistance?: number
}

export const DEFAULT_MIN_SAMPLES = 5;
export const RARE_EVENT_MIN_SAMPLES = 20;

function randomRangeLength(region: SamplingRegion) {
	// RandomPolicy leaves the last 10m of every region unused when choosing its trigger.
	return Math.max(0, region.end - region.start - 10);
}

function lateRaceOpportunityProbability(opportunity: RandomSkillOpportunity) {
	const lateStart = opportunity.courseDistance * 2 / 3;
	const spillDistance = Math.max(0, opportunity.spillDistance || 0);
	let total = 0, useful = 0;
	for (const region of opportunity.regions) {
		const end = region.start + randomRangeLength(region);
		const length = Math.max(0, end - region.start);
		total += length;
		useful += Math.max(0, Math.min(end, opportunity.courseDistance)
			- Math.max(region.start, lateStart - spillDistance));
	}
	return total > 0 ? Math.min(1, useful / total) : 0;
}

function samplesForOpportunity(probability: number) {
	if (probability <= 0) return DEFAULT_MIN_SAMPLES;
	// Require enough samples for a 95% chance of observing at least one useful
	// activation, rounded up to the adaptive checkpoints.
	const required = probability >= 1 ? 1 : Math.ceil(Math.log(0.05) / Math.log(1 - probability));
	if (required <= 20) return RARE_EVENT_MIN_SAMPLES;
	if (required <= 30) return 30;
	return 50;
}

/**
 * Protect random skills from an all-miss five-sample batch. Pure acceleration
 * skills keep the cheap path only when neither their trigger nor their active
 * duration can reach the late-race acceleration area.
 */
export function minimumAdaptiveSamples(opportunity: RandomSkillOpportunity) {
	if (!opportunity.isRandom) return DEFAULT_MIN_SAMPLES;
	if (!opportunity.isAccelerationOnly) return RARE_EVENT_MIN_SAMPLES;
	// This includes both triggers placed in late race and earlier effects whose
	// duration carries them across the boundary.
	return samplesForOpportunity(lateRaceOpportunityProbability(opportunity));
}
