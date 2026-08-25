import { h, Fragment } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import icons from '../icons.json';
import { STRATEGY_NAMES } from './strategy-names';
import umas from '../umas.json';
import skillmeta from '../skill_meta.json';
import skillnames from '../uma-skill-tools/data/skillnames.json';
import { CourseHelpers } from '../uma-skill-tools/CourseData';

import './RaceReplay.css';

const WIDTH = 900;
const HEIGHT = 430;
const TRACK_WIDTH = 62;
const ROUTE_STEP = 2;
const RUNNER_COLORS = ['#2a77c5','#c52a2a','#7b3fc6','#e78012','#008d71','#d34d93','#67731a','#006e9c','#795548','#555'];


const OUTFIT_NAMES = (() => {
	const names = {};
	Object.values(umas).forEach((uma:any) => Object.keys(uma.outfits).forEach(outfitId => names[outfitId] = uma.name[1] || uma.name[0]));
	return names;
})();

function cornerAt(course, distance) {
	return course.corners.find(corner => distance >= corner.start && distance < corner.start + corner.length);
}

/** Construct a schematic centerline from the exact longitudinal section data.
 *  Each numbered corner contributes a quarter turn; straights retain heading. */
function buildRoute(course) {
	const turnSign = course.turn == 2 ? -1 : 1;
	const raw = [{distance: 0, x: 0, y: 0, heading: 0}];
	let x = 0, y = 0, heading = 0;
	for (let start = 0; start < course.distance; start += ROUTE_STEP) {
		const ds = Math.min(ROUTE_STEP, course.distance - start);
		const corner = cornerAt(course, start + ds / 2);
		const turn = corner == null ? 0 : turnSign * Math.PI / 2 * ds / corner.length;
		const middleHeading = heading + turn / 2;
		x += Math.cos(middleHeading) * ds;
		y += Math.sin(middleHeading) * ds;
		heading += turn;
		raw.push({distance: start + ds, x, y, heading});
	}
	const minX = Math.min(...raw.map(p => p.x)), maxX = Math.max(...raw.map(p => p.x));
	const minY = Math.min(...raw.map(p => p.y)), maxY = Math.max(...raw.map(p => p.y));
	const rangeX = Math.max(1, maxX - minX), rangeY = Math.max(1, maxY - minY);
	const scale = Math.min((WIDTH - 120) / rangeX, (HEIGHT - 110) / rangeY);
	const left = (WIDTH - rangeX * scale) / 2, top = (HEIGHT - rangeY * scale) / 2;
	return raw.map(p => ({...p, x: left + (p.x - minX) * scale, y: top + (p.y - minY) * scale}));
}

function routePoint(route, distance) {
	const d = Math.max(0, Math.min(distance, route[route.length - 1].distance));
	const approximate = d / ROUTE_STEP;
	let lo = Math.min(Math.floor(approximate), route.length - 1);
	while (lo + 1 < route.length && route[lo + 1].distance < d) ++lo;
	while (lo > 0 && route[lo].distance > d) --lo;
	const hi = Math.min(lo + 1, route.length - 1);
	const span = route[hi].distance - route[lo].distance;
	const f = span == 0 ? 0 : (d - route[lo].distance) / span;
	return {
		x: route[lo].x + (route[hi].x - route[lo].x) * f,
		y: route[lo].y + (route[hi].y - route[lo].y) * f,
		heading: route[lo].heading + (route[hi].heading - route[lo].heading) * f
	};
}

function markerLine(point, length = 42) {
	const nx = -Math.sin(point.heading), ny = Math.cos(point.heading);
	return {x1: point.x - nx * length / 2, y1: point.y - ny * length / 2,
		x2: point.x + nx * length / 2, y2: point.y + ny * length / 2};
}

function phaseMarker(route, distance, label, className) {
	const point = routePoint(route, distance);
	const normalX = -Math.sin(point.heading), normalY = Math.cos(point.heading);
	return {
		distance, label, className, line: markerLine(point, 56),
		labelX: point.x + normalX * 42,
		labelY: point.y + normalY * 42
	};
}

function runnerIcon(outfitId) {
	const icon = icons[outfitId]?.[1];
	return icon ? `/uma-tools/icons/chara/${icon}.png` : '/uma-tools/icons/utx_ico_umamusume_00.png';
}

function runnerLabel(runner) {
	return runner.index == 0 ? `Uma 1${OUTFIT_NAMES[runner.outfitId] ? ` · ${OUTFIT_NAMES[runner.outfitId]}` : ''}`
		: runner.index == 1 ? `Uma 2${OUTFIT_NAMES[runner.outfitId] ? ` · ${OUTFIT_NAMES[runner.outfitId]}` : ''}`
		: OUTFIT_NAMES[runner.outfitId] || `Runner ${runner.index + 1}`;
}

function skillIcon(id) {
	return skillmeta[id]?.iconId ? `/uma-tools/icons/skill/utx_ico_skill_${skillmeta[id].iconId}.png` : null;
}

function skillName(id) {
	if (id == 'itidoriarasoi') return 'Spot Struggle';
	return skillnames[id]?.[0] || id;
}

function activationVisible(activation, time) {
	const end = activation.endTime >= activation.startTime ? activation.endTime : activation.startTime + 0.8;
	const epsilon = 1e-8;
	return time + epsilon >= activation.startTime && time <= Math.max(end, activation.startTime + 0.8) + epsilon;
}

const PACE_DOWN_END_LABELS = Object.freeze({
	'course-end': 'position-keep limit', 'pacer-gap': 'pacer gap',
	'section-limit': 'maximum section duration', 'kakari': 'Kakari'
});

function buildPaceDownEvents(runner, times) {
	const states = runner.state || [];
	const events = [];
	let activeStart = -1, preventionKey = '';
	for (let i = 0; i < states.length; ++i) {
		const state = states[i];
		if (state.paceDown && activeStart < 0) activeStart = i;
		if (!state.paceDown && activeStart >= 0) {
			events.push({type: 'active', startTime: times[activeStart] || 0, endTime: times[i] || 0,
				startPosition: runner.p[activeStart] || 0, endPosition: runner.p[i] || 0,
				reason: state.paceDownEndReason, skills: state.paceDownEndSkills || []});
			activeStart = -1;
		}
		const skills = state.paceDownPreventedBy || [];
		const key = skills.join(',');
		if (key && key != preventionKey) events.push({type: 'prevented', startTime: times[i] || 0,
			startPosition: runner.p[i] || 0, skills});
		preventionKey = key;
	}
	if (activeStart >= 0) events.push({type: 'active', startTime: times[activeStart] || 0,
		endTime: times[times.length - 1] || 0, startPosition: runner.p[activeStart] || 0,
		endPosition: runner.p[runner.p.length - 1] || 0, reason: null, skills: []});
	return events;
}

export function RaceReplay({replay, course, simulateLanes}) {
	const [frame, setFrame] = useState(0);
	const [playing, setPlaying] = useState(false);
	const [speed, setSpeed] = useState(1);
	const [selectedRunner, setSelectedRunner] = useState(0);
	const [expanded, setExpanded] = useState(false);
	const [followSelected, setFollowSelected] = useState(false);
	const [cameraZoom, setCameraZoom] = useState(3);
	const maxFrame = Math.max(0, replay.t.length - 1);
	const route = useMemo(() => buildRoute(course), [course]);
	const path = useMemo(() => route.map((point, index) => `${index == 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' '), [route]);
	const phaseMarkers = useMemo(() => [
		phaseMarker(route, CourseHelpers.phaseStart(course.distance, 1), 'MID-RACE', 'midRace'),
		phaseMarker(route, CourseHelpers.phaseStart(course.distance, 2), 'LATE-RACE · ACCEL ZONE', 'lateRace'),
		phaseMarker(route, CourseHelpers.phaseStart(course.distance, 3), 'LAST SPURT', 'lastSpurt')
	], [route, course.distance]);
	const maximumLane = useMemo(() => Math.max(1, ...replay.runners.flatMap(runner => runner.lane)), [replay]);
	const paceDownEvents = useMemo(() => replay.runners.map(runner => buildPaceDownEvents(runner, replay.t)), [replay]);

	useEffect(() => {
		setFrame(0);
		setPlaying(false);
	}, [replay]);

	useEffect(() => {
		if (!playing) return;
		const timer = window.setInterval(() => setFrame(current => {
			if (current >= maxFrame) {
				setPlaying(false);
				return current;
			}
			return Math.min(maxFrame, current + 1);
		}), Math.max(16, replay.dt * 1000 / speed));
		return () => window.clearInterval(timer);
	}, [playing, speed, maxFrame, replay.dt]);

	useEffect(() => {
		if (!expanded) return;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		const closeOnEscape = event => { if (event.key == 'Escape') setExpanded(false); };
		window.addEventListener('keydown', closeOnEscape);
		return () => {
			document.body.style.overflow = previousOverflow;
			window.removeEventListener('keydown', closeOnEscape);
		};
	}, [expanded]);

	const current = replay.runners.map(runner => {
		const runnerFrame = Math.min(frame, runner.p.length - 1);
		const position = runner.p[runnerFrame] || 0;
		const lane = runner.lane[runnerFrame] || 0;
		const point = routePoint(route, position);
		const normalX = -Math.sin(point.heading), normalY = Math.cos(point.heading);
		const innerSign = course.turn == 2 ? -1 : 1;
		const laneOffset = simulateLanes ? innerSign * (0.5 - lane / maximumLane) * (TRACK_WIDTH - 20) : 0;
		return {
			...runner, position, lane, state: runner.state?.[runnerFrame] || null,
			rank: runner.rank[Math.min(frame, runner.rank.length - 1)] || runner.index + 1,
			velocity: runner.v[Math.min(frame, runner.v.length - 1)] || 0,
			accelBonus: runner.accelBonus?.[runnerFrame] || 0,
			accelTotal: runner.accelTotal?.[runnerFrame] || 0,
			x: point.x + normalX * laneOffset,
			y: point.y + normalY * laneOffset
		};
	});
	const ordered = current.slice().sort((a,b) => a.rank - b.rank || a.index - b.index);
	const leaderPosition = ordered[0]?.position || 0;
	const startLine = markerLine(routePoint(route, 0));
	const finishLine = markerLine(routePoint(route, course.distance));
	const selected = current[selectedRunner] || current[0];
	const cameraWidth = WIDTH / cameraZoom;
	const cameraHeight = HEIGHT / cameraZoom;
	const cameraX = selected ? Math.max(0, Math.min(WIDTH - cameraWidth, selected.x - cameraWidth / 2)) : 0;
	const cameraY = selected ? Math.max(0, Math.min(HEIGHT - cameraHeight, selected.y - cameraHeight / 2)) : 0;
	const replayViewBox = followSelected
		? `${cameraX.toFixed(2)} ${cameraY.toFixed(2)} ${cameraWidth.toFixed(2)} ${cameraHeight.toFixed(2)}`
		: `0 0 ${WIDTH} ${HEIGHT}`;
	const runnerScale = followSelected ? 1 / cameraZoom : 1;
	const time = replay.t[Math.min(frame, replay.t.length - 1)] || 0;
	const selectedActivations = selected?.skillActivations || [];
	const selectedPaceEvents = paceDownEvents[selectedRunner] || [];
	const selectedBlock = selected?.state?.block || {front: [], side: [], inner: [], outer: []};
	const renderedRunners = current.slice().sort((a,b) => {
		if (a.index == selectedRunner) return 1;
		if (b.index == selectedRunner) return -1;
		return b.rank - a.rank || b.index - a.index;
	});

	function seekToTime(targetTime) {
		setPlaying(false);
		let targetFrame = Math.round(targetTime / replay.dt);
		if (replay.t.length > 0) {
			targetFrame = Math.max(0, Math.min(maxFrame, targetFrame));
			while (targetFrame < maxFrame && replay.t[targetFrame] < targetTime) ++targetFrame;
		}
		setFrame(targetFrame);
	}

	function blockerNames(indices) {
		return indices.map(index => current[index] ? runnerLabel(current[index]) : `Runner ${index + 1}`).join(', ');
	}

	function togglePlayback() {
		if (frame >= maxFrame) setFrame(0);
		setPlaying(value => !value);
	}

	return <section class={`raceReplayPanel ${expanded ? 'expanded' : ''}`}>
		<div class="raceReplayHeader">
			<div><h2>Median race replay</h2><span>{time.toFixed(2)} s · frame {frame}/{maxFrame}</span></div>
			<div class="raceReplaySelected">{selected && <><strong>{runnerLabel(selected)}</strong><span>{selected.position.toFixed(2)} m · rank {selected.rank} · lane {selected.lane.toFixed(2)} · {selected.velocity.toFixed(2)} m/s</span><span class="raceReplayAcceleration"><strong>Bonus accel {selected.accelBonus >= 0 ? '+' : ''}{selected.accelBonus.toFixed(2)} m/s²</strong><small>Total accel {selected.accelTotal >= 0 ? '+' : ''}{selected.accelTotal.toFixed(2)} m/s²</small></span></>}</div>
			<button class="raceReplayExpand" onClick={() => setExpanded(value => !value)}
				aria-label={expanded ? 'Close expanded replay' : 'Expand replay'}>{expanded ? '✕ Close full view' : '⛶ Full view'}</button>
		</div>
		{!simulateLanes && <p class="raceReplayWarning">Lane movement was disabled for this simulation. Longitudinal positions are exact, but all runners share the schematic center lane.</p>}
		<div class="raceReplayRunnerState">
			{selected?.state && <span><strong>Live order-change counters</strong>Mid-race {selected.state.changeOrderUpMiddle} · late-race {selected.state.changeOrderUpEndAfter} · final-corner onward {selected.state.changeOrderUpFinalCornerAfter}</span>}
			{simulateLanes && selected?.state && <span><strong>Runner immediately behind is farther inside</strong>{selected.state.isBehindIn ? 'Yes' : 'No'}</span>}
			{selected?.state?.paceDown ? <span class="paceDown active"><strong>Pace down active</strong>Target-speed coefficient is reduced.</span>
				: selected?.state?.paceDownPreventedBy?.length > 0 ? <span class="paceDown prevented"><strong>Pace down prevented</strong>by {selected.state.paceDownPreventedBy.map(skillName).join(', ')}</span>
				: selected?.state?.paceDownEndReason ? <span class="paceDown ended"><strong>Pace down ended</strong>{selected.state.paceDownEndReason == 'speed-skill'
					? `by ${selected.state.paceDownEndSkills.map(skillName).join(', ')}` : `due to ${PACE_DOWN_END_LABELS[selected.state.paceDownEndReason] || selected.state.paceDownEndReason}`}</span>
				: <span><strong>Pace down inactive</strong></span>}
			{selectedBlock.front.length > 0 && <span><strong>Blocked in front by</strong>{blockerNames(selectedBlock.front)}</span>}
			{selectedBlock.inner.length > 0 && <span><strong>Blocked on inner side by</strong>{blockerNames(selectedBlock.inner)}</span>}
			{selectedBlock.outer.length > 0 && <span><strong>Blocked on outer side by</strong>{blockerNames(selectedBlock.outer)}</span>}
			{selectedBlock.side.length > 0 && <span><strong>Side-block condition (lane-free approximation)</strong>{blockerNames(selectedBlock.side)}</span>}
			{selectedBlock.front.length + selectedBlock.side.length + selectedBlock.inner.length + selectedBlock.outer.length == 0 && <span><strong>Not blocked</strong></span>}
		</div>
		<div class="raceReplayCameraControls" aria-label="Replay camera controls">
			<span>Camera</span>
			<button class={!followSelected ? 'active' : ''} onClick={() => setFollowSelected(false)}>Whole track</button>
			<button class={followSelected ? 'active' : ''} onClick={() => setFollowSelected(true)}>Follow selected Uma</button>
			<label class={!followSelected ? 'disabled' : ''}>Zoom
				<input type="range" min="2" max="5" step="0.5" value={cameraZoom} disabled={!followSelected}
					onInput={event => setCameraZoom(+event.currentTarget.value)} />
				<strong>{cameraZoom.toFixed(1)}×</strong>
			</label>
			{followSelected && <small>Local distances are magnified; portraits retain a readable size.</small>}
		</div>
		<div class="raceReplayStage">
			<svg viewBox={replayViewBox} role="img" aria-label={`Top-down median race replay at ${time.toFixed(2)} seconds${followSelected ? `, following ${runnerLabel(selected)}` : ''}`}>
				<defs>
					{current.map(runner => <clipPath id={`replayIconClip${runner.index}`}><circle cx="0" cy="0" r="15" /></clipPath>)}
				</defs>
				<rect class="raceReplayInfield" width={WIDTH} height={HEIGHT} rx="16" />
				<path class="raceReplayRail" d={path} />
				<path class={`raceReplayTrack ${course.surface == 2 ? 'dirt' : 'turf'}`} d={path} />
				<path class="raceReplayCenterLine" d={path} />
				{phaseMarkers.map(marker => <g class={`raceReplayPhaseMarker ${marker.className}`}>
					<line {...marker.line} />
					<text x={marker.labelX} y={marker.labelY}>{marker.label}<tspan x={marker.labelX} dy="10">{Math.round(marker.distance)} m</tspan></text>
				</g>)}
				<line class="raceReplayStart" {...startLine} />
				<line class="raceReplayFinish" {...finishLine} />
				<text class="raceReplayMarkerText" x={route[0].x} y={route[0].y - 31}>START</text>
				<text class="raceReplayMarkerText" x={route[route.length - 1].x} y={route[route.length - 1].y - 31}>FINISH</text>
				{renderedRunners.map(runner => <g class={`raceReplayRunner ${selectedRunner == runner.index ? 'selected' : ''}`}
					transform={`translate(${runner.x.toFixed(2)} ${runner.y.toFixed(2)}) scale(${runnerScale.toFixed(4)})`} onClick={() => setSelectedRunner(runner.index)}>
					<circle class="runnerRing" r="18" fill={RUNNER_COLORS[runner.index % RUNNER_COLORS.length]} />
					<image href={runnerIcon(runner.outfitId)} x="-15" y="-15" width="30" height="30" clip-path={`url(#replayIconClip${runner.index})`} />
					<circle class="runnerNumberBg" cx="12" cy="-12" r="7" fill={RUNNER_COLORS[runner.index % RUNNER_COLORS.length]} />
					<text class="runnerNumber" x="12" y="-12">{runner.index + 1}</text>
					{(runner.skillActivations || []).filter(activation => activationVisible(activation, time)).slice(0, 3).map((activation, index) =>
						skillIcon(activation.id) && <image class="raceReplaySkillIcon" href={skillIcon(activation.id)}
							x={-12 + index * 17} y="-43" width="24" height="24"><title>{skillName(activation.id)}</title></image>)}
					{runner.state?.paceDown && <g class="raceReplayPaceDownBadge"><rect x="-18" y="20" width="36" height="13" rx="4" /><text x="0" y="26.5">PACE DOWN</text></g>}
				</g>)}
			</svg>
			<div class="raceReplayStandings">
				{ordered.map(runner => <button class={selectedRunner == runner.index ? 'selected' : ''} onClick={() => setSelectedRunner(runner.index)}>
					<span class="replayRank">{runner.rank}</span><img src={runnerIcon(runner.outfitId)} /><span class="replayRunnerName">{runnerLabel(runner)}<small>{STRATEGY_NAMES[runner.strategy] || runner.strategy}</small></span>
					<span class="replayPosition">{runner.position.toFixed(2)} m<small>{runner.rank == 1 ? 'Leader' : `${(leaderPosition - runner.position).toFixed(2)} m behind`}</small></span>
				</button>)}
			</div>
		</div>
		<div class="raceReplayControls">
			<button class="raceReplayPlay" onClick={togglePlayback} aria-label={playing ? 'Pause replay' : 'Play replay'}>{playing ? '❚❚' : '▶'}</button>
			<button onClick={() => { setPlaying(false); setFrame(Math.max(0, frame - 1)); }} aria-label="Previous frame">‹</button>
			<input type="range" min="0" max={maxFrame} value={frame} onInput={event => { setPlaying(false); setFrame(+event.currentTarget.value); }} />
			<button onClick={() => { setPlaying(false); setFrame(Math.min(maxFrame, frame + 1)); }} aria-label="Next frame">›</button>
			<select value={speed} onChange={event => setSpeed(+event.currentTarget.value)} aria-label="Replay speed">
				<option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option>
			</select>
		</div>
		<div class="raceReplayActivations">
			<strong>{runnerLabel(selected)} pace-down history</strong>
			{selectedPaceEvents.length == 0 ? <span class="noReplayActivations">No pace-down or skill-prevention events in this replay.</span> :
				<div class="raceReplayActivationList paceDownHistory">{selectedPaceEvents.map(event => <button onClick={() => seekToTime(event.startTime)}>
					<span class="paceEventIcon">PD</span><span>{event.type == 'prevented' ? 'Pace down prevented' : 'Pace down'}
						<small>{event.type == 'prevented'
							? `${event.startTime.toFixed(2)} s · ${event.startPosition.toFixed(1)} m · by ${event.skills.map(skillName).join(', ')}`
							: `${event.startTime.toFixed(2)}–${event.endTime.toFixed(2)} s · ${event.reason == 'speed-skill'
								? `ended by ${event.skills.map(skillName).join(', ')}` : `ended by ${PACE_DOWN_END_LABELS[event.reason] || 'replay end'}`}`}</small>
					</span>
				</button>)}</div>}
			<strong>{runnerLabel(selected)} skill activations</strong>
			{selectedActivations.length == 0 ? <span class="noReplayActivations">No skills activated in this replay.</span> :
				<div class="raceReplayActivationList">{selectedActivations.map(activation => <button
					class={activationVisible(activation, time) ? 'active' : ''} onClick={() => seekToTime(activation.startTime)}
					title={`Jump to ${activation.startTime.toFixed(2)} seconds`}>
					{skillIcon(activation.id) && <img src={skillIcon(activation.id)} />}
					<span>{skillName(activation.id)}<small>{activation.startTime.toFixed(2)} s · {activation.startPosition.toFixed(1)} m</small></span>
				</button>)}</div>}
		</div>
		<p class="raceReplayNote">Positions, ranks, lanes, modes, and skill activations come from the stored 15 Hz median run. Pace down uses the engine’s synthetic position-keep pacer, not one of the visible field runners. Blocking labels show the geometry used by skill conditions; physical blocking slowdown is not simulated. Phase markers use the engine’s fixed boundaries: mid-race at 1/6, late-race acceleration zone at 2/3, and last-spurt phase at 5/6 of the course. Track geometry is a schematic reconstructed from the course’s exact straight, corner, distance, and turn-direction data.</p>
	</section>;
}
