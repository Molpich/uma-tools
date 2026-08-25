export interface StepSegment {
	startPosition: number
	endPosition: number
	startTime: number
	endTime: number
}

function clampUnit(value: number) {
	return Math.max(0, Math.min(1, value));
}

/** Estimate the instant a runner crossed the finish without changing the 15 Hz race simulation. */
export function interpolateFinishTime(distance: number, segment: StepSegment) {
	const travelled = segment.endPosition - segment.startPosition;
	if (!(segment.startPosition < distance && segment.endPosition >= distance)) return null;
	if (!(travelled > 0) || !(segment.endTime > segment.startTime)) return segment.endTime;
	const fraction = clampUnit((distance - segment.startPosition) / travelled);
	return segment.startTime + fraction * (segment.endTime - segment.startTime);
}

function interpolatePosition(segment: StepSegment, time: number) {
	const duration = segment.endTime - segment.startTime;
	if (!(duration > 0)) return segment.endPosition;
	const fraction = clampUnit((time - segment.startTime) / duration);
	return segment.startPosition + fraction * (segment.endPosition - segment.startPosition);
}

/** Signed head-to-head gap at the first interpolated finish: negative means runner 1 wins. */
export function interpolateFinishGap(distance: number, first: StepSegment, second: StepSegment) {
	const firstTime = interpolateFinishTime(distance, first);
	const secondTime = interpolateFinishTime(distance, second);
	if (firstTime == null && secondTime == null) return null;
	if (firstTime != null && secondTime != null && Math.abs(firstTime - secondTime) < 1e-9) return 0;
	if (firstTime != null && (secondTime == null || firstTime < secondTime)) {
		return -(distance - interpolatePosition(second, firstTime)) / 2.5;
	}
	return (distance - interpolatePosition(first, secondTime!)) / 2.5;
}
