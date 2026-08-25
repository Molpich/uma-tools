import { h, Fragment, render } from 'preact';
import { useState, useReducer, useMemo, useEffect, useRef, useId, useCallback } from 'preact/hooks';
import { memo } from 'preact/compat';
import { Text, MarkupText, Localizer, IntlProvider } from 'preact-i18n';
import * as d3 from 'd3';
import { computePosition, flip } from '@floating-ui/dom';

import { CourseHelpers } from '../uma-skill-tools/CourseData';
import { RaceParameters, Mood, GroundCondition, Weather, Season, Time, Grade } from '../uma-skill-tools/RaceParameters';
import type { GameHpPolicy } from '../uma-skill-tools/HpPolicy';

import { O, c, K, State, makeState, useLens, useGetter, useSetter, useInspectState } from '../optics';

import { Language, LanguageSelect, useLanguageSelect } from '../components/Language';
import { SkillList, ExpandedSkillDetails, skillGroups, isPurpleSkill } from '../components/SkillList';
import { RaceTrack, TrackSelect, RegionDisplayType } from '../components/RaceTrack';
import { HorseState, DEFAULT_HORSE_STATE, makeDefaultOpponent, makeDefaultOpponentRoster, serializeUma, deserializeUma } from '../components/HorseDefTypes';
import { HorseDef, horseDefTabs, isGeneralSkill } from '../components/HorseDef';
import { extendStrings, TRACKNAMES_ja, TRACKNAMES_en, COMMON_STRINGS } from '../strings/common';

import { getActivateableSkills, getNullRow, BasinnChart } from './BasinnChart';
import { UmaChart } from './UmaChart';
import { getUmaTableCandidates } from './uma-table';
import { StaCalcResults } from './StaCalc';

import { initTelemetry, postEvent } from './telemetry';

import { IntroText } from './IntroText';
import { RaceReplay } from './RaceReplay';

import skilldata from '../uma-skill-tools/data/skill_data.json';
import skillnames from '../uma-skill-tools/data/skillnames.json';
import skillmeta from '../skill_meta.json';

import '../UmaUI.css';
import './app.css';

const DEFAULT_SAMPLES = 500;
const DEFAULT_SEED = 2615953739;

const UI_ja = Object.freeze({
	'lengthsunit': 'バ身',
	'resultshelp': '負の数とは<strong class="uma1">第一ウマ娘</strong>の方が速い。正の数とは<strong class="uma2">第二ウマ娘</strong>の方が速い。',
	'uma': 'ウマ娘',
	'uma1': '第一ウマ娘',
	'uma2': '第二ウマ娘',
	'debuffer': 'デバフ',
	'mode': Object.freeze({
		'compare': '真っ向勝負',
		'chart': 'スキル効果値',
		'stacalc': 'Stamina calculator'
	}),
	'sidebar': Object.freeze({
		'samples': '標本数',
		'seed': '乱数シード',
		'poskeep': 'Simulate pos keep',
		'competetop': '位置取り争いを発動する',
		'intchecks': 'Wisdom checks for skills',
		'showhp': 'Show HP consumption',
		'run': Object.freeze({
			'compare': '比べる',
			'chart': '実行する',
			'stacalc': 'Calculate'
		}),
		'copylink': 'リンクをコピー'
	}),
	'basinnchartselection': Object.freeze({
		'all': '全スキル',
		'inherit': '継承固有スキル',
		'selected': '選択したスキル',
		'addskill': '+ スキル追加',
		'clear': 'クリア'
	}),
	'kakari': '掛かり',
	'itidoriarasoi': '位置取り争い'
});
const UI_en = Object.freeze({
	'lengthsunit': 'bashin',
	'resultshelp': 'Negative numbers mean <strong class="uma1">Umamusume 1</strong> is faster, positive numbers mean <strong class="uma2">Umamusume 2</strong> is faster.',
	'uma': 'Umamusume',
	'uma1': 'Umamusume 1',
	'uma2': 'Umamusume 2',
	'debuffer': 'Debuffer',
	'mode': Object.freeze({
		'compare': 'Compare',
		'chart': 'Skill table',
		'stacalc': 'Stamina calculator'
	}),
	'sidebar': Object.freeze({
		'samples': 'Samples:',
		'seed': 'Seed:',
		'poskeep': 'Simulate pos keep',
		'competetop': 'Enable lead compete',
		'intchecks': 'Wisdom checks for skills',
		'showhp': 'Show HP consumption',
		'run': Object.freeze({
			'compare': 'COMPARE',
			'chart': 'RUN',
			'stacalc': 'CALCULATE'
		}),
		'copylink': 'Copy link'
	}),
	'basinnchartselection': Object.freeze({
		'all': 'All skills',
		'inherit': 'Inherited uniques',
		'selected': 'Selected skills',
		'addskill': '+ Add Skill',
		'clear': 'Clear'
	}),
	'kakari': 'Kakari',
	'itidoriarasoi': 'Lead Compete'
});
const UI_global = extendStrings(UI_en, {
	'lengthsunit': 'lengths',
	'sidebar': extendStrings(UI_en['sidebar'], {
		'competetop': 'Enable Spot Struggle',
		'intchecks': 'Wit checks for skills'
	}),
	'kakari': 'Rushed',
	'itidoriarasoi': 'Spot Struggle'
});

const UI_STRINGS = Object.freeze({
	'ja': UI_ja,
	'en': UI_en,
	'en-ja': UI_en,
	'en-global': UI_global
});

interface RaceParams {
	ground: GroundCondition
	weather: Weather
	season: Season
	time: Time
	grade: Grade
}

const DEFAULT_RACE_PARAMS = {
	ground: GroundCondition.Good,
	weather: Weather.Sunny,
	season: Season.Spring,
	time: Time.Midday,
	grade: Grade.G1
};

function shallowEquals(o1, o2) {
	if (o1 == null || o2 == null) return o1 === o2;
	// assume o1 and o2 have the same shape
	return Object.keys(o1).reduce((b,k) => b && Object.is(o1[k], o2[k]), true);
}

function horseEquals(h1, h2) {
	return h1 == h2 || Object.keys(h1).reduce((b,k) => {
		if (!b) return false;
		if (k == 'skills') {
			const s1 = h1.skills, s2 = h2.skills;
			return s1.size == s2.size && Array.from(s1.keys()).reduce((b,k) => b && s1.get(k) == s2.get(k), true);
		} else if (k == 'samplePolicies') {
			return Array.from(h1.skills.values()).every(id => shallowEquals(h1.samplePolicies.get(id), h2.samplePolicies.get(id))) && Array.from(h2.skills.values()).every(id => shallowEquals(h1.samplePolicies.get(id), h2.samplePolicies.get(id)));
		} else {
			return Object.is(h1[k], h2[k]);
		}
	}, true);
}

const enum EventType { CM, LOH }

//  ja: 良   稍重     重   不良
//  en: good yielding soft heavy
// gbl: firm good     soft heavy
const presets = (CC_GLOBAL ? [
	{type: EventType.CM, name: 'Libra Cup 2', date: '2026-08-25', courseId: 10903, season: Season.Autumn, ground: GroundCondition.Good, weather: Weather.Cloudy, time: Time.Midday},
	{type: EventType.CM, name: 'Virgo Cup 2', date: '2026-08-05', courseId: 11103, season: Season.Autumn, ground: GroundCondition.Yielding, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.CM, name: 'Leo Cup 2', date: '2026-07-25', courseId: 10501, season: Season.Summer, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.CM, name: 'Cancer Cup 2', date: '2026-06-24', courseId: 10906, season: Season.Summer, ground: GroundCondition.Yielding, weather: Weather.Cloudy, time: Time.Midday},
	{type: EventType.CM, name: 'Gemini Cup 2', date: '2026-06-04', courseId: 10602, season: Season.Spring, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.CM, name: 'Taurus Cup 2', date: '2026-05-10', courseId: 10606, season: Season.Spring, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.CM, name: 'Aries Cup', date: '2026-04-23', courseId: 10504, season: Season.Spring, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.CM, name: 'Pisces Cup', date: '2026-03-30', courseId: 10914, season: Season.Spring, ground: GroundCondition.Heavy, weather: Weather.Rainy, time: Time.Midday},
	{type: EventType.CM, name: 'Aquarius Cup', date: '2026-03-06', courseId: 10611, season: Season.Winter, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.CM, name: 'Capricorn Cup', date: '2026-02-13', courseId: 10701, season: Season.Winter, ground: GroundCondition.Soft, weather: Weather.Snowy, time: Time.Midday},
	{type: EventType.CM, name: 'Sagittarius Cup', date: '2026-01-23', courseId: 10506, season: Season.Winter, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.CM, name: 'Scorpio Cup', date: '2026-01-01', courseId: 10604, season: Season.Autumn, ground: GroundCondition.Soft, weather: Weather.Rainy, time: Time.Midday},
	{type: EventType.CM, name: 'Libra Cup', date: '2025-12-12', courseId: 10810, season: Season.Autumn, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.CM, name: 'Virgo Cup', date: '2025-11-20', courseId: 10903, season: Season.Autumn, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.CM, name: 'Leo Cup', date: '2025-10-30', courseId: 10906, season: Season.Summer, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.CM, name: 'Cancer Cup', date: '2025-10-07', courseId: 10602, season: Season.Summer, ground: GroundCondition.Yielding, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.CM, name: 'Gemini Cup', date: '2025-09-11', courseId: 10811, season: Season.Spring, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.CM, name: 'Taurus Cup', date: '2025-08-21', courseId: 10606, season: Season.Spring, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday}
] : [
	{type: EventType.CM, date: '2026-09-30' /* TODO date */, courseId: 10603, season: Season.Autumn, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.LOH, date: '2026-08-31' /* TODO date */, courseId: 10504, season: Season.Summer, time: Time.Midday},
	{type: EventType.CM, date: '2026-07-24', courseId: 10507, season: Season.Summer, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.CM, date: '2026-06-23', courseId: 10606, season: Season.Spring, ground: GroundCondition.Soft, weather: Weather.Cloudy, time: Time.Midday},
	{type: EventType.LOH, date: '2026-05-22', courseId: 10801, season: Season.Spring, time: Time.Midday},
	{type: EventType.CM, date: '2026-04-23', courseId: 11709, season: Season.Spring, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.CM, date: '2026-03-22', courseId: 11703, season: Season.Spring, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.LOH, date: '2026-02-15', courseId: 10602, season: Season.Winter, time: Time.Midday},
	{type: EventType.CM, date: '2026-01-22', courseId: 10506, season: Season.Winter, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.CM, date: '2025-12-21', courseId: 10903, season: Season.Winter, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.LOH, date: '2025-11-21', courseId: 11502, season: Season.Autumn, time: Time.Midday},
	{type: EventType.CM, date: '2025-10-23', courseId: 10302, season: Season.Autumn, ground: GroundCondition.Good, weather: Weather.Cloudy, time: Time.Midday},
	{type: EventType.CM, date: '2025-09-22', courseId: 10807, season: Season.Autumn, ground: GroundCondition.Good, weather: Weather.Sunny, time: Time.Midday},
	{type: EventType.LOH, date: '2025-08-15', courseId: 10105, season: Season.Summer, Time: Time.Midday},
	{type: EventType.CM, date: '2025-07-25', courseId: 10906, ground: GroundCondition.Yielding, weather: Weather.Cloudy, season: Season.Summer, time: Time.Midday},
	{type: EventType.CM, date: '2025-06-21', courseId: 10606, ground: GroundCondition.Good, weather: Weather.Sunny, season: Season.Spring, time: Time.Midday}
])
	.map(def => ({
		type: def.type,
		name: def.name,
		date: new Date(def.date),
		courseId: def.courseId,
		racedef: {
			ground: def.type == EventType.CM ? def.ground : GroundCondition.Good,
			weather: def.type == EventType.CM ? def.weather : Weather.Sunny,
			season: def.season,
			time: def.time,
			grade: Grade.G1
		}
	}))
	.sort((a,b) => +b.date - +a.date);

const DEFAULT_PRESET = presets[Math.max(presets.findIndex((now => p => p.date < now)(new Date())) - 1, 0)];
const DEFAULT_COURSE_ID = DEFAULT_PRESET.courseId;

function id(x) { return x; }

function toggle(b) { return !b; }

function binSearch(a: number[], x: number) {
	let lo = 0, hi = a.length - 1;
	if (x < a[0]) return 0;
	if (x > a[hi]) return hi - 1;
	while (lo <= hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (x < a[mid]) {
			hi = mid - 1;
		} else if (x > a[mid]) {
			lo = mid + 1;
		} else {
			return mid;
		}
	}
	return Math.abs(a[lo] - x) < Math.abs(a[hi] - x) ? lo : hi;
}

function TimeOfDaySelect(props) {
	const [t, setT] = useLens(props.t);
	function click(e) {
		e.stopPropagation();
		if (!('timeofday' in e.target.dataset)) return;
		setT(+e.target.dataset.timeofday);
	}
	// + 2 because for some reason the icons are 00-02 (noon/evening/night) but the enum values are 1-4 (morning(?) noon evening night)
	return (
		<div class="timeofdaySelect" onClick={click}>
			<Localizer>
				{Array(3).fill(0).map((_,i) =>
					<img src={`/uma-tools/icons/utx_ico_timezone_0${i}.png`} title={<Text id={`common.time.${i+2}`} />}
						class={i+2 == t ? 'selected' : ''} data-timeofday={i+2} />)}
			</Localizer>
		</div>
	);
}

function GroundSelect(props) {
	const [g, setG] = useLens(props.g);
	return (
		<select class="groundSelect" value={g} onInput={(e) => setG(+e.currentTarget.value)}>
			<option value="1"><Text id="common.ground.1" /></option>
			<option value="2"><Text id="common.ground.2" /></option>
			<option value="3"><Text id="common.ground.3" /></option>
			<option value="4"><Text id="common.ground.4" /></option>
		</select>
	);
}

function WeatherSelect(props) {
	const [w, setW] = useLens(props.w);
	function click(e) {
		e.stopPropagation();
		if (!('weather' in e.target.dataset)) return;
		setW(+e.target.dataset.weather);
	}
	return (
		<div class="weatherSelect" onClick={click}>
			<Localizer>
				{Array(4).fill(0).map((_,i) =>
					<img src={`/uma-tools/icons/utx_ico_weather_0${i}.png`} title={<Text id={`common.weather.${i+1}`} />}
						class={i+1 == w ? 'selected' : ''} data-weather={i+1} />)}
			</Localizer>
		</div>
	);
}

function SeasonSelect(props) {
	const [s, setS] = useLens(props.s);
	function click(e) {
		e.stopPropagation();
		if (!('season' in e.target.dataset)) return;
		setS(+e.target.dataset.season);
	}
	return (
		<div class="seasonSelect" onClick={click}>
			<Localizer>
				{Array(4 + +!CC_GLOBAL /* global doesnt have late spring for some reason */).fill(0).map((_,i) =>
					<img src={`/uma-tools/icons${CC_GLOBAL?'/global':''}/utx_txt_season_0${i}.png`} title={<Text id={`common.season.${i+1}`} />}
						class={i+1 == s ? 'selected' : ''} data-season={i+1} />)}
			</Localizer>
		</div>
	);
}

const [UMA1_COLOR, UMA2_COLOR] = (function (cs) {
	return [cs.getPropertyValue('--uma1-color'), cs.getPropertyValue('--uma2-color')];
})(window.getComputedStyle(document.documentElement));

const Histogram = memo(function Histogram(props) {
	const {data, width, height} = props;
	const axes = useRef(null);
	const xH = 20;
	const yW = 40;

	const x = d3.scaleLinear().domain(
		data[0] == 0 && data[data.length-1] == 0
			? [-1,1]
			: [Math.min(0,Math.floor(data[0])),Math.ceil(data[data.length-1])]
	).range([yW,width-yW]);
	const bucketize = d3.bin().value(id).domain(x.domain()).thresholds(x.ticks(30));
	const buckets = bucketize(data);
	const y = d3.scaleLinear().domain([0,d3.max(buckets, b => b.length)]).range([height-xH,xH]);

	useEffect(function () {
		const g = d3.select(axes.current);
		g.selectAll('*').remove();
		g.append('g').attr('transform', `translate(0,${height - xH})`).call(d3.axisBottom(x));
		g.append('g').attr('transform', `translate(${yW},0)`).call(d3.axisLeft(y));
	}, [data, width, height]);

	const rects = buckets.map((b,i) =>
		<rect key={i} fill={b.x1 <= 0 || !props.splitColors ? UMA1_COLOR : UMA2_COLOR} stroke="black" x={x(b.x0)} y={y(b.length)} width={x(b.x1) - x(b.x0)} height={height - xH - y(b.length)} />
	);
	return (
		<svg id="histogram" width={width} height={height}>
			<g>{rects}</g>
			<g ref={axes}></g>
		</svg>
	);
});

function BasinnChartPopover(props) {
	const popover = useRef(null);
	useEffect(function () {
		if (popover.current == null) return;
		// bit nasty
		const anchor = document.querySelector(`.basinnChart tr[data-skillid="${props.skillid}"] img`);
		computePosition(anchor, popover.current, {
			placement: 'bottom-start',
			middleware: [flip()]
		}).then(({x,y}) => {
			popover.current.style.transform = `translate(${x}px,${y}px)`;
			popover.current.style.visibility = 'visible';
		});
		popover.current.focus();
	}, [popover.current, props.skillid]);
	return (
		<div class="basinnChartPopover" tabindex="1000" style="visibility:hidden" ref={popover}>
			<ExpandedSkillDetails id={props.skillid} distanceFactor={props.courseDistance} dismissable={false} />
			<Histogram width={500} height={333} data={props.results} splitColors={true} />
		</div>
	);
}

const VelocityLines = memo(function VelocityLines(props) {
	const axes = useRef(null);
	const data = props.data;
	const x = d3.scaleLinear().domain([0,props.courseDistance]).range([0,props.width]);
	const y = data && d3.scaleLinear().domain([0,d3.max(data.v, v => d3.max(v))]).range([props.height,0]);
	const hpY = data && d3.scaleLinear().domain([0,d3.max(data.hp, hp => d3.max(hp))]).range([props.height,0]);
	useEffect(function () {
		if (axes.current == null) return;
		const g = d3.select(axes.current);
		g.selectAll('*').remove();
		g.append('g').attr('transform', `translate(${props.xOffset},${props.height+5})`).call(d3.axisBottom(x));
		if (data) {
			g.append('g').attr('transform', `translate(${props.xOffset},4)`).call(d3.axisLeft(y));
		}
	}, [props.data, props.courseDistance, props.width, props.height]);
	const colors = [UMA1_COLOR, UMA2_COLOR];
	return (
		<Fragment>
			<g transform={`translate(${props.xOffset},5)`}>
				{data && data.v.map((v,i) =>
					<path fill="none" stroke={colors[i]} stroke-width="2.5" d={
						d3.line().x(j => x(data.p[i][j])).y(j => y(v[j]))(data.p[i].map((_,j) => j))
					} />
				).concat(props.showHp ? data.hp.map((hp,i) =>
					<path fill="none" stroke={colors[i]} stroke-width="2.5" stroke-dasharray="5,2" d={
						d3.line().x(j => x(data.p[i][j])).y(j => hpY(hp[j]))(data.p[i].map((_,j) => j))
					} />
				) : [])}
			</g>
			<g ref={axes} />
		</Fragment>
	);
});

const MonteCarloChart = memo(function MonteCarloChart(props) {
	const axes = useRef(null);
	const {stats, width, height, kind} = props;
	const margin = {top: 18, right: 20, bottom: 42, left: 64};
	const innerWidth = width - margin.left - margin.right;
	const innerHeight = height - margin.top - margin.bottom;
	const byDistance = kind == 'leadByDistance';
	const xValues = byDistance ? stats.distance : stats.time;
	const leadValues = byDistance ? stats.leadByDistance : stats.lead;
	const x = d3.scaleLinear().domain([0, byDistance ? props.courseDistance : stats.time[stats.time.length - 1]]).range([0,innerWidth]);
	let yDomain;
	if (kind == 'speed') {
		const maxSpeed = d3.max(stats.meanVelocity[0].concat(stats.meanVelocity[1]));
		yDomain = [0, maxSpeed || 1];
	} else {
		const extent = d3.max(leadValues, d => Math.max(Math.abs(d.p10), Math.abs(d.p90), Math.abs(d.mean)));
		yDomain = extent == 0 ? [-1,1] : [-extent,extent];
	}
	const y = d3.scaleLinear().domain(yDomain).nice().range([innerHeight,0]);
	useEffect(function () {
		const g = d3.select(axes.current);
		g.selectAll('*').remove();
		g.append('g').attr('transform', `translate(0,${innerHeight})`).call(d3.axisBottom(x));
		g.append('g').call(d3.axisLeft(y));
	}, [stats, width, height, kind]);
	const line = d3.line().x((_,i) => x(xValues[i])).y(d => y(d));
	const leadLine = field => d3.line().x((_,i) => x(xValues[i])).y(d => y(d[field]))(leadValues);
	const band = (low, high) => d3.area().x((_,i) => x(xValues[i])).y0(d => y(d[low])).y1(d => y(d[high]))(leadValues);
	return (
		<svg class="monteCarloChart" width={width} height={height} role="img" aria-label={props.title}>
			<text class="chartTitle" x={width / 2} y="14" text-anchor="middle">{props.title}</text>
			<g transform={`translate(${margin.left},${margin.top})`}>
				{kind == 'speed' ? <Fragment>
					<path fill="none" stroke={UMA1_COLOR} stroke-width="2.5" d={line(stats.meanVelocity[0])} />
					<path fill="none" stroke={UMA2_COLOR} stroke-width="2.5" d={line(stats.meanVelocity[1])} />
				</Fragment> : <Fragment>
					<path class="leadBandOuter" d={band('p10','p90')} />
					<path class="leadBandInner" d={band('p25','p75')} />
					<line class="zeroLine" x1="0" x2={innerWidth} y1={y(0)} y2={y(0)} />
					<path fill="none" stroke="#222" stroke-width="2.5" d={leadLine('mean')} />
					<path fill="none" stroke="#555" stroke-width="2" stroke-dasharray="6,4" d={leadLine('median')} />
				</Fragment>}
				<g ref={axes} />
				<text class="axisLabel" x={innerWidth / 2} y={innerHeight + 36} text-anchor="middle">{byDistance ? 'Race position (meters)' : 'Time (seconds)'}</text>
				<text class="axisLabel" transform="rotate(-90)" x={-innerHeight / 2} y={-48} text-anchor="middle">{kind == 'speed' ? 'Speed (m/s)' : 'Uma 1 lead (meters)'}</text>
			</g>
		</svg>
	);
});

function formatDistribution(d, unit) {
	return d == null ? '—' : `${d.median.toFixed(2)} ${unit} (p10 ${d.p10.toFixed(2)}, p90 ${d.p90.toFixed(2)})`;
}

function WinRateSummary(props) {
	const format = count => `${(100 * count / props.winRate.total).toFixed(1)}%`;
	const [uma1, uma2] = props.winRate.wins;
	return (
		<div id="winRateSummary">
			<div>Head-to-head win rate: Uma 1 {format(uma1)} · Uma 2 {format(uma2)} · ties {format(props.winRate.ties)}</div>
			{props.fieldWinRate && <div>Field win rate: Uma 1 {format(props.fieldWinRate.wins[0])} · Uma 2 {format(props.fieldWinRate.wins[1])} · other runners {format(Math.max(0, props.fieldWinRate.total - props.fieldWinRate.wins[0] - props.fieldWinRate.wins[1] - props.fieldWinRate.ties))} · ties {format(props.fieldWinRate.ties)}</div>}
		</div>
	);
}

const MonteCarloAnalysis = memo(function MonteCarloAnalysis(props) {
	const stats = props.stats;
	const hasSkillStats = stats.skillActivations.some(uma => uma.length > 0);
	return (
		<section id="monteCarloAnalysis">
			<h2>All-run Monte Carlo analysis</h2>
			<p class="analysisNote">These graphs use all {stats.runs} runs. The speed graph averages each runner's recorded velocity and treats them as stopped after finishing; the lead graphs keep finished runners at {props.courseDistance} m. The velocity/HP display above remains one representative individual run.</p>
			<div class="analysisLegend"><span class="uma1Swatch" />Uma 1 <span class="uma2Swatch" />Uma 2 <span class="meanSwatch" />Mean lead <span class="medianSwatch" />Median lead; bands p25–p75 and p10–p90</div>
			<MonteCarloChart kind="speed" title="Speed vs Time" stats={stats} courseDistance={props.courseDistance} width={920} height={290} />
			<MonteCarloChart kind="lead" title="Lead vs Time" stats={stats} courseDistance={props.courseDistance} width={920} height={290} />
			<MonteCarloChart kind="leadByDistance" title="Relative Lead vs Race Position" stats={stats} courseDistance={props.courseDistance} width={920} height={290} />
			<p class="analysisNote">For the distance-indexed graph, race position is the frontmost runner's distance at that instant. Each run stops at the first finish, so the endpoint preserves the winner's finishing gap. Positive values mean Uma 1 is ahead; negative values mean Uma 2 is ahead.</p>
			<p class="consistencyCheck">Numerical check: max |mean(p1−p2) − (mean(p1)−mean(p2))| = {stats.identityMaxError.toExponential(3)} m</p>
			{hasSkillStats && <div class="activationStats">
				<h3>Skill activation statistics</h3>
				{stats.skillActivations.map((uma,i) => uma.length > 0 && <table class={`activationTable uma${i+1}`}>
					<caption>Uma {i+1}</caption>
					<thead><tr><th>Skill</th><th>Activation rate</th><th>Never activated</th><th>Activation distance</th><th>Activation time</th></tr></thead>
					<tbody>{uma.map(s => <tr>
						<th><img src={`/uma-tools/icons/skill/utx_ico_skill_${skillmeta[s.id].iconId}.png`} />{skillnames[s.id][0]}</th>
						<td>{(s.activationRate * 100).toFixed(1)}% ({s.activatedRuns}/{stats.runs})</td>
						<td>{s.neverActivated}</td>
						<td>{formatDistribution(s.position, 'm')}</td>
						<td>{formatDistribution(s.time, 's')}</td>
					</tr>)}</tbody>
				</table>)}
			</div>}
		</section>
	);
});

const ResultsTable = memo(function ResultsTable(props) {
	const {caption, class:cls, chartData, idx, spurtRate} = props;
	return (
		<table class={cls}>
			<caption><div>{caption}</div></caption>
			<tbody>
				<tr><th>Time to finish</th><td>{chartData.t[idx][chartData.t[idx].length-1].toFixed(4) + ' s'}</td></tr>
				<tr><th>Full spurt rate</th><td>{(spurtRate * 100).toFixed(2) + '%'}</td></tr>
				<tr><th>Start delay</th><td>{chartData.sdly[idx].toFixed(4) + ' s'}</td></tr>
				<tr><th>Top speed</th><td>{chartData.v[idx].reduce((a,b) => Math.max(a,b), 0).toFixed(2) + ' m/s'}</td></tr>
				<tr><th>Time in downhill speedup mode</th><td>{chartData.dh[idx].toFixed(2) + ' s'}</td></tr>
			</tbody>
			{chartData.sk[idx].size > 0 &&
				<tbody>
					{Array.from(chartData.sk[idx].entries()).flatMap(([id,ars]) => SPECIAL_SKILLS.indexOf(id) > -1 ? [] : ars.map(pos =>
						<tr>
							<th><img src={`/uma-tools/icons/skill/utx_ico_skill_${skillmeta[id].iconId}.png`} /><span>{skillnames[id][0]}</span></th>
							<td>{pos[1] == -1 ? `${pos[0].toFixed(2)} m` : `${pos[0].toFixed(2)} m – ${pos[1].toFixed(2)} m`}</td>
						</tr>))}
				</tbody>}
		</table>
	);
});

const NO_SHOW = Object.freeze([
	'10011', '10012', '10016', '10021', '10022', '10026', '10031', '10032', '10036',
	'10041', '10042', '10046', '10051', '10052', '10056', '10061', '10062', '10066',
	'40011',
	'20061', '20062', '20066'
]);

const SPECIAL_SKILLS = Object.freeze(['kakari', 'itidoriarasoi']);

const ORDER_RANGE_FOR_STRATEGY = Object.freeze({
	'Nige': [1,1],
	'Senkou': [2,4],
	'Sasi': [5,9],
	'Oikomi': [5,9],
	'Oonige': [1,1]
});

function racedefToParams({ground, weather, season, time, grade}: RaceParams, includeOrder?: string): RaceParameters {
	return {
		groundCondition: ground, weather, season, time, grade,
		skillId: '',
		orderRange: includeOrder != null ? ORDER_RANGE_FOR_STRATEGY[includeOrder] : null,
		numUmas: 9
	};
}

async function serialize(courseId: number, nsamples: number, seed: number, usePosKeep: boolean, useCompeteTop: boolean, useIntChecks: boolean, rankAwareField: boolean, simulateLanes: boolean, fieldSize: number, racedef: RaceParams, hintLevels: Map<string,number>, uma1: HorseState, uma2: HorseState, fieldUmas: HorseState[], debufUma: HorseState, chartMode: string | null, chartSkills: string[] | null) {
	const o = {
		courseId,
		nsamples,
		seed,
		usePosKeep,
		useCompeteTop,
		useIntChecks,
		rankAwareField,
		simulateLanes,
		fieldSize,
		racedef,
		hintLevels: Object.fromEntries([...hintLevels].filter(([_,l]) => l > 0)),
		uma1: serializeUma(uma1),
		uma2: serializeUma(uma2),
		fieldUmas: fieldUmas.map(serializeUma),
	};
	if (chartMode != null) o.chartMode = chartMode;
	if (chartSkills != null) o.chartSkills = chartSkills;
	// not serializing this unless it has been modified means that when DEFAULT_HORSE_STATE changes (eg with stat cap updates)
	// we'll load a different uma, but given that presumably DEFAULT_HORSE_STATE will never include any debuffs that doesn't
	// actually matter
	if (!horseEquals(debufUma, DEFAULT_HORSE_STATE)) {
		o.debufUma = serializeUma(debufUma);
	}
	const json = JSON.stringify(o);
	const enc = new TextEncoder();
	const stringStream = new ReadableStream({
		start(controller) {
			controller.enqueue(enc.encode(json));
			controller.close();
		}
	});
	const zipped = stringStream.pipeThrough(new CompressionStream('gzip'));
	const reader = zipped.getReader();
	let buf = new Uint8Array();
	let result;
	while ((result = await reader.read())) {
		if (result.done) {
			return encodeURIComponent(btoa(String.fromCharCode(...buf)));
		} else {
			buf = new Uint8Array([...buf, ...result.value]);
		}
	}
}

async function deserialize(hash) {
	const zipped = atob(decodeURIComponent(hash));
	const buf = new Uint8Array(zipped.split('').map(c => c.charCodeAt(0)));
	const stringStream = new ReadableStream({
		start(controller) {
			controller.enqueue(buf);
			controller.close();
		}
	});
	const unzipped = stringStream.pipeThrough(new DecompressionStream('gzip'));
	const reader = unzipped.getReader();
	const decoder = new TextDecoder();
	let json = '';
	let result;
	while ((result = await reader.read())) {
		if (result.done) {
			try {
				const o = JSON.parse(json);
				const uma1 = deserializeUma(o.uma1);
				const uma2 = deserializeUma(o.uma2);
				return {
					courseId: o.courseId,
					nsamples: o.nsamples,
					seed: o.seed || DEFAULT_SEED,  // field added later (v2), could be undefined when loading state from existing links
					usePosKeep: o.usePosKeep,
					useCompeteTop: o.useCompeteTop ?? true,  // v9
					useIntChecks: o.useIntChecks || false,  // v3
					rankAwareField: o.rankAwareField || false,
					simulateLanes: o.simulateLanes || false,
					fieldSize: o.fieldSize || 9,
					racedef: o.racedef,
					hintLevels: new Map([...allZeroHints, ...(o.hintLevels ? Object.entries(o.hintLevels) : [])]),  // v10
					uma1,
					uma2,
					fieldUmas: o.fieldUmas ? o.fieldUmas.map(deserializeUma) : makeDefaultOpponentRoster(uma1, uma2),
					debufUma: deserializeUma(o.debufUma || serializeUma(DEFAULT_HORSE_STATE)),  // v7
					// optional fields (only added when serialized from basinn chart screen)
					chartMode: o.chartMode || 'all',  // v6
					chartSkills: o.chartSkills || null  // v4
				};
			} catch (_) {
				return {
					courseId: DEFAULT_COURSE_ID,
					nsamples: DEFAULT_SAMPLES,
					seed: DEFAULT_SEED,
					usePosKeep: true,
					useCompeteTop: true,
					useIntChecks: false,
					rankAwareField: false,
					simulateLanes: false,
					fieldSize: 9,
					racedef: DEFAULT_RACE_PARAMS,
					hintLevels: new Map(allZeroHints),
					uma1: DEFAULT_HORSE_STATE,
					uma2: DEFAULT_HORSE_STATE,
					fieldUmas: makeDefaultOpponentRoster(DEFAULT_HORSE_STATE, DEFAULT_HORSE_STATE),
					debufUma: DEFAULT_HORSE_STATE,
					chartMode: 'all',
					chartSkills: null
				};
			}
		} else {
			json += decoder.decode(result.value);
		}
	}
}

const RacePresets = memo(function RacePresets(props) {
	const [courseId, setCourseId] = useLens(props.courseId);
	const [racedef, setRacedef] = useLens(props.racedef);
	const selectedIdx = presets.findIndex(p => p.courseId == courseId && shallowEquals(p.racedef, racedef));
	function change(e) {
		const i = +e.currentTarget.value;
		if (i > -1) {
			setCourseId(presets[i].courseId);
			setRacedef(presets[i].racedef);
		}
	}
	return (
		<fieldset class="presetSelect">
			<legend>Preset</legend>
			<select onChange={change}>
				<option value="-1"></option>
				{presets.map((p,i) => <option value={i} selected={i == selectedIdx}>{p.name || (p.date.getUTCFullYear() + '-' + (100 + p.date.getUTCMonth() + 1).toString().slice(-2) + (p.type == EventType.CM ? ' CM' : ' LOH'))}</option>)}
			</select>
		</fieldset>
	);
}, K(true));

const NOT_REAL_UNIQUES = ['1400011', '1400021'];  // ?? what are these
const allSkills = Object.keys(skilldata).filter(id => NOT_REAL_UNIQUES.indexOf(id) == -1);
const nonPurpleSkills = allSkills.filter(id => !isPurpleSkill(id));
const baseSkillsToTest = nonPurpleSkills.filter(isGeneralSkill);
const allZeroHints = new Map(allSkills.map(id => [id,0]));

function getNullTableData(skills) {
	const filler = new Map();
	skills.forEach(id => filler.set(id, getNullRow(id)));
	return filler;
}

function pathValue(base, routeDesc, default_) {
	const k = Object.keys(routeDesc);
	const url = window.location.pathname.slice(base.length);
	const i = k.findIndex(path => url.indexOf(path) != -1);
	return i == -1 ? default_ : routeDesc[k[i]];
}

function useRoute<T>(base: string, getRouteDesc: () => Record<string,T>, default_: T, deps: any[]=[]): [T, (value: T) => void] {
	const routeDesc = useMemo(getRouteDesc, deps);
	const reverse = useMemo(() => {
		const reverse = new Map();
		Object.keys(routeDesc).forEach((path,value) => reverse.set(value, path));
		return reverse;
	}, [routeDesc]);
	const [lastNav, setLastNav] = useState(default_);
	const [current, setCurrent] = useState(() => pathValue(base, routeDesc, default_));
	useEffect(function () {
		function pageshow() {
			const v = pathValue(base, routeDesc, default_);
			setCurrent(v);
			setLastNav(v);
		}
		function popstate(e) {
			setCurrent(e.state != null ? e.state : lastNav);
		}
		window.addEventListener('pageshow', pageshow);
		window.addEventListener('popstate', popstate);
		return function () {
			window.removeEventListener('pageshow', pageshow);
			window.removeEventListener('popstate', popstate);
		};
	}, [routeDesc, lastNav]);
	const navigate = useCallback(function (value) {
		window.history.pushState(value, '', base + reverse.get(value) + window.location.hash);
		setCurrent(value);
	}, [routeDesc]);
	return [current, navigate];
}

const enum Mode { Compare, Chart, StaCalc }

const NULL_RESULTS = Object.freeze({results: [], runData: null});

function cloneHorse(uma: HorseState): HorseState {
	return deserializeUma(serializeUma(uma));
}

const FIELD_PRESET_STORAGE_KEY = 'uma-tools.field-presets.v1';
const FIELD_PRESET_FORMAT = 'uma-tools-field-presets';

interface FieldPreset {
	version: 1
	id: string
	name: string
	courseId: number | null
	fieldSize: number
	runners: ReturnType<typeof serializeUma>[]
	createdAt: string
	modifiedAt: string
}

function makeFieldPresetId() {
	return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeFieldPreset(value): FieldPreset | null {
	if (value == null || typeof value != 'object' || !Array.isArray(value.runners)) return null;
	const fieldSize = Math.max(2, Math.min(18, Math.trunc(+value.fieldSize || value.runners.length + 2)));
	const runners = value.runners.slice(0, fieldSize - 2);
	try {
		runners.forEach(deserializeUma);
	} catch (_) {
		return null;
	}
	const now = new Date().toISOString();
	return {
		version: 1,
		id: typeof value.id == 'string' && value.id.length > 0 ? value.id : makeFieldPresetId(),
		name: typeof value.name == 'string' && value.name.trim().length > 0 ? value.name.trim() : 'Imported field',
		courseId: Number.isFinite(+value.courseId) ? +value.courseId : null,
		fieldSize,
		runners,
		createdAt: typeof value.createdAt == 'string' ? value.createdAt : now,
		modifiedAt: typeof value.modifiedAt == 'string' ? value.modifiedAt : now
	};
}

function loadFieldPresets(): FieldPreset[] {
	try {
		const values = JSON.parse(localStorage.getItem(FIELD_PRESET_STORAGE_KEY) || '[]');
		return Array.isArray(values) ? values.map(normalizeFieldPreset).filter(Boolean) : [];
	} catch (_) {
		return [];
	}
}

function fieldPresetCourseLabel(courseId: number | null) {
	if (courseId == null) return 'Any course';
	try {
		const course = CourseHelpers.getCourse(courseId);
		return `${TRACKNAMES_en[course.raceTrackId] || `Course ${courseId}`} ${course.distance}m`;
	} catch (_) {
		return `Course ${courseId}`;
	}
}

const STRATEGY_IDS: Readonly<Record<HorseState['strategy'], number>> = Object.freeze({
	Nige: 1,
	Senkou: 2,
	Sasi: 3,
	Oikomi: 4,
	Oonige: 5
});

function StrategyLabel(props: {strategy: HorseState['strategy']}) {
	const id = STRATEGY_IDS[props.strategy];
	return id == null ? <>{props.strategy}</> : <Text id={`common.strategy.${id}`} />;
}

const OpponentRoster = memo(function OpponentRoster(props) {
	const [fieldUmas, setFieldUmas] = useLens(O.fieldUmas);
	const [, setUma2] = useLens(O.uma2);
	const opponentCount = Math.max(0, props.fieldSize - 2);
	const [selected_, setSelected] = useState<number | null>(-1);
	const [fieldPresets, setFieldPresets] = useState<FieldPreset[]>(loadFieldPresets);
	const [selectedPresetId, setSelectedPresetId] = useState('builtin:synthetic');
	const [presetName, setPresetName] = useState('Untitled field');
	const [presetMessage, setPresetMessage] = useState('');
	const importInput = useRef<HTMLInputElement>(null);
	const selected = props.embedded && selected_ == null
		? null
		: selected_ != null && selected_ >= 0
			? Math.min(selected_, Math.max(0, opponentCount - 1))
			: -1;
	const compactOverview = props.embedded && selected == null;
	const selectedPreset = fieldPresets.find(preset => preset.id == selectedPresetId) || null;
	const presetPreview = selectedPreset == null
		? Array.from({length: opponentCount}, (_, index) => serializeUma(makeDefaultOpponent(props.uma1, props.uma2, index)))
		: selectedPreset.runners;
	useEffect(() => {
		try {
			localStorage.setItem(FIELD_PRESET_STORAGE_KEY, JSON.stringify(fieldPresets));
		} catch (_) {
			setPresetMessage('Preset changes could not be saved in this browser.');
		}
	}, [fieldPresets]);
	useEffect(() => {
		if (selectedPreset != null) setPresetName(selectedPreset.name);
	}, [selectedPresetId]);
	useEffect(() => {
		if (fieldUmas.length < opponentCount) {
			setFieldUmas(umas => {
				const next = umas.slice();
				while (next.length < opponentCount) next.push(makeDefaultOpponent(props.uma1, props.uma2, next.length));
				return next;
			});
		}
	}, [opponentCount, fieldUmas.length]);

	function ensureAndSelect(index: number) {
		if (index >= fieldUmas.length) {
			setFieldUmas(umas => {
				const next = umas.slice();
				while (next.length <= index) next.push(makeDefaultOpponent(props.uma1, props.uma2, next.length));
				return next;
			});
		}
		setSelected(index);
	}

	function selectRunner(index: number) {
		if (index < 0) setSelected(-1);
		else ensureAndSelect(index);
	}

	function replaceSelected(uma: HorseState) {
		if (selected < 0) {
			setUma2(cloneHorse(uma));
			return;
		}
		setFieldUmas(umas => {
			const next = umas.slice();
			next[selected] = cloneHorse(uma);
			return next;
		});
	}

	function addRunner() {
		if (props.fieldSize >= 18) return;
		const index = opponentCount;
		ensureAndSelect(index);
		props.setFieldSize(props.fieldSize + 1);
	}

	function currentPresetRunners() {
		return fieldUmas.slice(0, opponentCount).map(serializeUma);
	}

	function saveNewPreset() {
		const name = presetName.trim();
		if (name.length == 0) {
			setPresetMessage('Enter a preset name first.');
			return;
		}
		const now = new Date().toISOString();
		const preset: FieldPreset = {
			version: 1, id: makeFieldPresetId(), name, courseId: props.courseId,
			fieldSize: props.fieldSize, runners: currentPresetRunners(), createdAt: now, modifiedAt: now
		};
		setFieldPresets(presets => [preset, ...presets]);
		setSelectedPresetId(preset.id);
		setPresetMessage(`Saved “${name}”.`);
	}

	function updateSelectedPreset() {
		if (selectedPreset == null) return;
		setFieldPresets(presets => presets.map(preset => preset.id == selectedPreset.id ? {
			...preset,
			courseId: props.courseId,
			fieldSize: props.fieldSize,
			runners: currentPresetRunners(),
			modifiedAt: new Date().toISOString()
		} : preset));
		setPresetMessage(`Updated “${selectedPreset.name}” from the current field.`);
	}

	function renameSelectedPreset() {
		if (selectedPreset == null) return;
		const name = presetName.trim();
		if (name.length == 0) {
			setPresetMessage('Enter a preset name first.');
			return;
		}
		setFieldPresets(presets => presets.map(preset => preset.id == selectedPreset.id
			? {...preset, name, modifiedAt: new Date().toISOString()} : preset));
		setPresetMessage(`Renamed preset to “${name}”.`);
	}

	function applySelectedPreset() {
		if (selectedPreset == null) {
			setFieldUmas(makeDefaultOpponentRoster(props.uma1, props.uma2));
			setPresetMessage('Applied the synthetic no-skill baseline.');
		} else {
			props.setFieldSize(selectedPreset.fieldSize);
			setFieldUmas(selectedPreset.runners.map(deserializeUma));
			setPresetMessage(`Applied “${selectedPreset.name}”.`);
		}
		setSelected(0);
	}

	function duplicateSelectedPreset() {
		if (selectedPreset == null) return;
		const now = new Date().toISOString();
		const copy = {...selectedPreset, id: makeFieldPresetId(), name: `${selectedPreset.name} copy`, createdAt: now, modifiedAt: now};
		setFieldPresets(presets => [copy, ...presets]);
		setSelectedPresetId(copy.id);
		setPresetName(copy.name);
		setPresetMessage(`Created “${copy.name}”.`);
	}

	function deleteSelectedPreset() {
		if (selectedPreset == null || !window.confirm(`Delete field preset “${selectedPreset.name}”?`)) return;
		setFieldPresets(presets => presets.filter(preset => preset.id != selectedPreset.id));
		setSelectedPresetId('builtin:synthetic');
		setPresetName('Untitled field');
		setPresetMessage(`Deleted “${selectedPreset.name}”.`);
	}

	function exportSelectedPreset() {
		const presets = selectedPreset == null ? fieldPresets : [selectedPreset];
		if (presets.length == 0) {
			setPresetMessage('There are no custom presets to export.');
			return;
		}
		const blob = new Blob([JSON.stringify({format: FIELD_PRESET_FORMAT, version: 1, presets}, null, 2)], {type: 'application/json'});
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = selectedPreset == null ? 'uma-tools-field-presets.json' : `${selectedPreset.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'field-preset'}.json`;
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		setTimeout(() => URL.revokeObjectURL(url), 0);
		setPresetMessage(`Exported ${presets.length} preset${presets.length == 1 ? '' : 's'}.`);
	}

	async function importPresets(e) {
		const file = e.currentTarget.files?.[0];
		if (file == null) return;
		try {
			const value = JSON.parse(await file.text());
			const source = Array.isArray(value) ? value : value?.format == FIELD_PRESET_FORMAT ? value.presets : [value];
			const imported = (Array.isArray(source) ? source : []).map(normalizeFieldPreset).filter(Boolean).map(preset => ({...preset, id: makeFieldPresetId()}));
			if (imported.length == 0) throw new Error('No valid presets');
			setFieldPresets(presets => [...imported, ...presets]);
			setSelectedPresetId(imported[0].id);
			setPresetName(imported[0].name);
			setPresetMessage(`Imported ${imported.length} preset${imported.length == 1 ? '' : 's'}.`);
		} catch (_) {
			setPresetMessage('That file does not contain a valid field preset.');
		}
		e.currentTarget.value = '';
	}

	const opponentCards = <div class="opponentCards">
		<button class={`opponentCard tracked ${selected === -1 ? 'selected' : ''}`} onClick={() => selectRunner(-1)}>
			<strong>Uma 2</strong><span>Runner 2 · Comparison opponent</span><small><img class="opponentCardUmaIcon" src="/uma-tools/icons/utx_ico_umamusume_00.png" alt="" /><StrategyLabel strategy={props.uma2.strategy} /> · {props.uma2.skills.size} skills</small>
		</button>
		{fieldUmas.slice(0, opponentCount).map((uma, index) =>
			<button class={`opponentCard ${selected == index ? 'selected' : ''} ${!props.fieldEnabled ? 'fieldInactive' : ''}`} onClick={() => selectRunner(index)} title={!props.fieldEnabled ? 'This runner is configured but only participates when Experimental full-field ranks is enabled.' : ''}>
				<strong>Runner {index + 3}</strong><span><StrategyLabel strategy={uma.strategy} /></span>
				<small><img class="opponentCardUmaIcon" src="/uma-tools/icons/utx_ico_umamusume_00.png" alt="" />{uma.speed}/{uma.stamina}/{uma.power}/{uma.guts}/{uma.wisdom} · {uma.skills.size} skills</small>
			</button>)}
	</div>;

	if (props.embedded) {
		const embeddedSelected = selected == null ? -1 : selected;
		const embeddedUma = embeddedSelected < 0 ? props.uma2 : fieldUmas[embeddedSelected];
		return <section id="opponentRoster" class="embeddedOpponentRoster">
			{embeddedUma && <HorseDef key={`embedded-${embeddedSelected < 0 ? 'uma2' : embeddedSelected}-${embeddedUma.outfitId}`} state={embeddedSelected < 0 ? O.uma2 : O.fieldUmas[embeddedSelected]} aptitudesMode="simulation" course={props.course} showPolicyEd={true} tabstart={() => 4}>
				{embeddedSelected < 0 ? <Text id="ui.uma2" /> : `Runner ${embeddedSelected + 3}`}
			</HorseDef>}
			<div class="embeddedRunnerListLabel">Other runners</div>
			{opponentCards}
			{props.fieldEnabled && embeddedSelected >= 0 && <div class="embeddedFieldTools">
				<div class="fieldRunnerActions">
					<span>Runners 3–{props.fieldSize}</span>
					<button class="stdBtn" onClick={addRunner} disabled={props.fieldSize >= 18}>Add runner</button>
					<button class="stdBtn" onClick={() => props.setFieldSize(Math.max(2, props.fieldSize - 1))} disabled={opponentCount == 0}>Remove last</button>
				</div>
				<details class="embeddedFieldPresetDetails">
					<summary>Field presets</summary>
					<div class="fieldPresetManager">
						<div class="fieldPresetHeading">
							<div>
								<strong>Field presets</strong>
								<small>Saved locally in this browser. Presets contain runners 3–{props.fieldSize}, including stats, styles, aptitudes, skills, and activation policies.</small>
							</div>
							<span class="fieldPresetCourse">Current: {fieldPresetCourseLabel(props.courseId)}</span>
						</div>
						<div class="fieldPresetControls">
							<label>Preset
								<select value={selectedPresetId} onChange={e => setSelectedPresetId(e.currentTarget.value)}>
									<option value="builtin:synthetic">Synthetic baseline (no skills)</option>
									{fieldPresets.map(preset => <option value={preset.id}>{preset.name} — {fieldPresetCourseLabel(preset.courseId)}</option>)}
								</select>
							</label>
							<label>Name
								<input type="text" value={presetName} onInput={e => setPresetName(e.currentTarget.value)} />
							</label>
							<button class="stdBtn btnType1" onClick={applySelectedPreset}>Apply</button>
							<button class="stdBtn btnType1" onClick={saveNewPreset}>Save new</button>
							<button class="stdBtn btnType2" onClick={updateSelectedPreset} disabled={selectedPreset == null}>Update</button>
							<button class="stdBtn btnType2" onClick={renameSelectedPreset} disabled={selectedPreset == null}>Rename</button>
							<button class="stdBtn btnType2" onClick={duplicateSelectedPreset} disabled={selectedPreset == null}>Duplicate</button>
							<button class="stdBtn btnType2" onClick={deleteSelectedPreset} disabled={selectedPreset == null}>Delete</button>
							<button class="stdBtn btnType2" onClick={exportSelectedPreset}>Export</button>
							<button class="stdBtn btnType2" onClick={() => importInput.current?.click()}>Import</button>
							<input class="fieldPresetImport" ref={importInput} type="file" accept="application/json,.json" onChange={importPresets} />
						</div>
						{presetMessage && <p class="fieldPresetMessage" role="status">{presetMessage}</p>}
						<details class="fieldPresetPreview">
							<summary>Preview: {presetPreview.length} opponents · {presetPreview.reduce((sum, runner) => sum + (runner.skills?.length || 0), 0)} skills{selectedPreset != null && <> · {fieldPresetCourseLabel(selectedPreset.courseId)}</>}</summary>
							<div class="fieldPresetRunnerList">
								{presetPreview.map((runner, index) => <div class="fieldPresetRunner">
									<strong>Runner {index + 3}</strong>
									<span><StrategyLabel strategy={runner.strategy} /></span>
									<small>{runner.speed}/{runner.stamina}/{runner.power}/{runner.guts}/{runner.wisdom}</small>
									<div class="fieldPresetSkillList">{runner.skills?.length > 0 ? runner.skills.map(id => <span><Text id={`skillnames.${id}`} /></span>) : <em>No skills</em>}</div>
								</div>)}
							</div>
						</details>
					</div>
				</details>
			</div>}
		</section>;
	}

	if (compactOverview) return <section id="opponentRoster" class="embeddedOpponentRoster compactOpponentRoster">
		<div class="opponentRosterHeader">
			<div>
				<h2>Other Umas</h2>
				<p>Select a runner to edit stats, style, aptitudes, skills, and activation policies.</p>
			</div>
		</div>
		{opponentCards}
		<p class="compactOpponentHint">Uma 2 is the comparison opponent used by normal compare and skill-table simulations. Full-field runners appear here when full-field ranks are enabled.</p>
	</section>;

	return <section id="opponentRoster" class={props.fieldEnabled ? 'fieldEnabled' : ''}>
		<div class="opponentRosterHeader">
			<div>
				<h2>Other Umas</h2>
				<p>Uma 2 (Runner 2) is the comparison opponent. Full-field mode adds runners 3–{props.fieldSize} behind the same editor.</p>
			</div>
		</div>
		<div class="otherUmaTabs" role="tablist" aria-label="Other Uma editor">
			<button role="tab" aria-selected={selected < 0} class={selected < 0 ? 'selected' : ''} onClick={() => setSelected(-1)}>Comparison opponent</button>
			<button role="tab" aria-selected={selected >= 0} class={selected >= 0 ? 'selected' : ''} onClick={() => ensureAndSelect(0)} disabled={!props.fieldEnabled}>Field runners</button>
		</div>
		{props.fieldEnabled && selected >= 0 && <div class="fieldRunnerActions">
			<span>Runners 3–{props.fieldSize}</span>
			<button class="stdBtn" onClick={addRunner} disabled={props.fieldSize >= 18}>Add runner</button>
			<button class="stdBtn" onClick={() => props.setFieldSize(Math.max(2, props.fieldSize - 1))} disabled={opponentCount == 0}>Remove last</button>
		</div>}
		{props.fieldEnabled && selected >= 0 && <div class="fieldPresetManager">
			<div class="fieldPresetHeading">
				<div>
					<strong>Field presets</strong>
					<small>Saved locally in this browser. Presets contain runners 3–{props.fieldSize}, including stats, styles, aptitudes, skills, and activation policies.</small>
				</div>
				<span class="fieldPresetCourse">Current: {fieldPresetCourseLabel(props.courseId)}</span>
			</div>
			<div class="fieldPresetControls">
				<label>Preset
					<select value={selectedPresetId} onChange={e => setSelectedPresetId(e.currentTarget.value)}>
						<option value="builtin:synthetic">Synthetic baseline (no skills)</option>
						{fieldPresets.map(preset => <option value={preset.id}>{preset.name} — {fieldPresetCourseLabel(preset.courseId)}</option>)}
					</select>
				</label>
				<label>Name
					<input type="text" value={presetName} onInput={e => setPresetName(e.currentTarget.value)} />
				</label>
				<button class="stdBtn btnType1" onClick={applySelectedPreset}>Apply</button>
				<button class="stdBtn btnType1" onClick={saveNewPreset}>Save new</button>
				<button class="stdBtn btnType2" onClick={updateSelectedPreset} disabled={selectedPreset == null}>Update</button>
				<button class="stdBtn btnType2" onClick={renameSelectedPreset} disabled={selectedPreset == null}>Rename</button>
				<button class="stdBtn btnType2" onClick={duplicateSelectedPreset} disabled={selectedPreset == null}>Duplicate</button>
				<button class="stdBtn btnType2" onClick={deleteSelectedPreset} disabled={selectedPreset == null}>Delete</button>
				<button class="stdBtn btnType2" onClick={exportSelectedPreset}>Export</button>
				<button class="stdBtn btnType2" onClick={() => importInput.current?.click()}>Import</button>
				<input class="fieldPresetImport" ref={importInput} type="file" accept="application/json,.json" onChange={importPresets} />
			</div>
			{presetMessage && <p class="fieldPresetMessage" role="status">{presetMessage}</p>}
			<details class="fieldPresetPreview">
				<summary>
					Preview: {presetPreview.length} opponents · {presetPreview.reduce((sum, runner) => sum + (runner.skills?.length || 0), 0)} skills
					{selectedPreset != null && <> · {fieldPresetCourseLabel(selectedPreset.courseId)}</>}
				</summary>
				<div class="fieldPresetRunnerList">
					{presetPreview.map((runner, index) => <div class="fieldPresetRunner">
						<strong>Runner {index + 3}</strong>
						<span><StrategyLabel strategy={runner.strategy} /></span>
						<small>{runner.speed}/{runner.stamina}/{runner.power}/{runner.guts}/{runner.wisdom}</small>
						<div class="fieldPresetSkillList">
							{runner.skills?.length > 0 ? runner.skills.map(id => <span><Text id={`skillnames.${id}`} /></span>) : <em>No skills</em>}
						</div>
					</div>)}
				</div>
			</details>
		</div>}
		{opponentCards}
		<div class="opponentEditor">
			<div class="opponentEditorActions">
				<strong>{selected < 0 ? 'Editing Uma 2 (comparison opponent)' : `Editing runner ${selected + 3}`}</strong>
				{props.embedded && <button onClick={() => setSelected(null)}>Back to runner overview</button>}
				<button onClick={() => replaceSelected(props.uma1)}>Copy Uma 1</button>
				{selected >= 0 && <button onClick={() => replaceSelected(props.uma2)}>Copy comparison opponent</button>}
				<button onClick={() => replaceSelected(makeDefaultOpponent(props.uma1, props.uma2, Math.max(0, selected)))}>Reset synthetic</button>
			</div>
			{selected < 0 ? <HorseDef key={`comparison-${props.uma2.outfitId}`} state={O.uma2} aptitudesMode="simulation" course={props.course} showPolicyEd={true} tabstart={() => 4 + horseDefTabs()}>
				Uma 2 · Comparison opponent
			</HorseDef> : fieldUmas[selected] && <HorseDef key={`opponent-${selected}-${fieldUmas[selected].outfitId}`} state={O.fieldUmas[selected]} aptitudesMode="simulation" course={props.course} showPolicyEd={true} tabstart={() => 4 + 2 * horseDefTabs()}>
				Runner {selected + 3}
			</HorseDef>}
		</div>
		<p class={`fieldApproximationNotice ${!props.fieldEnabled ? 'optionUnavailable' : ''}`}><strong>Experimental field model:</strong> optional lane movement affects lane-qualified skill conditions. Physical blocking slowdown is not applied.</p>
	</section>;
});

function Umalator(props) {
	//const [language, setLanguage] = useLanguageSelect();
	const [racedef] = useLens(O.racedef);
	const [nsamples, setSamples] = useLens(O.nsamples);
	const [seed, setSeed] = useLens(O.seed);
	const [usePosKeep, setPosKeep] = useLens(O.usePosKeep); const togglePosKeep = () => setPosKeep(toggle);
	const [useCompeteTop, setCompeteTop] = useLens(O.useCompeteTop); const toggleCompeteTop = () => setCompeteTop(toggle);
	const [useIntChecks_, setIntChecks] = useLens(O.useIntChecks); const toggleIntChecks = () => setIntChecks(toggle);
	const [rankAwareField, setRankAwareField] = useLens(O.rankAwareField);
	const [simulateLanes, setSimulateLanes] = useLens(O.simulateLanes);
	const toggleRankAwareField = () => {
		if (rankAwareField) setSimulateLanes(false);
		setRankAwareField(toggle);
	};
	const toggleSimulateLanes = () => setSimulateLanes(toggle);
	const [fieldSize, setFieldSize] = useLens(O.fieldSize);
	const [showHp, setShowHp] = useLens(O.useShowHp); const toggleShowHp = () => setShowHp(toggle);
	const [courseId, setCourseId_] = useLens(O.courseId);
	const [displaying, setChartData] = useLens(O.displayedRun);
	const course = useMemo(() => CourseHelpers.getCourse(courseId), [courseId]);

	const [mode, setMode] = useRoute(CC_GLOBAL ? '/uma-tools/umalator-global' : '/uma-tools/umalator', () => ({
		'/compare': Mode.Compare,
		'/skills': Mode.Chart,
		'/stamina': Mode.StaCalc
	}), Mode.Compare);

	const useIntChecks = useIntChecks_ || mode == Mode.StaCalc;

	const [compareResults, setCompareResults] = useState(NULL_RESULTS);
	const [chartSelectionResults, setChartSelectionResults] = useState(NULL_RESULTS);
	const [stacalcResults, setStacalcResults] = useState(NULL_RESULTS);
	const {results, runData} = [compareResults, chartSelectionResults, stacalcResults][mode];
	const chartData = runData && runData[displaying];

	const [tableData, setTableData] = useLens(O.tableData);
	function updateTableData(newData) {
		setTableData(data => {
			const merged = new Map();
			data.forEach((v,k) => merged.set(k,v));
			newData.forEach((v,k) => merged.set(k,v));
			return merged;
		});
	}

	function updateUmaTableData(newData) {
		setUmaTableData(data => new Map([...data, ...newData]));
	}

	function setCourseId(cid) {
		setCourseId_(cid);
		setCompareResults(NULL_RESULTS);
		setChartSelectionResults(NULL_RESULTS);
		setStacalcResults(NULL_RESULTS);
	}

	const [uma1] = useLens(O.uma1);
	const [uma2] = useLens(O.uma2);
	const [fieldUmas] = useLens(O.fieldUmas);
	const [debufUma] = useLens(O.debufUma);
	const [staminaEditor, setStaminaEditor] = useState<'uma' | 'debuffer'>('uma');
	const [umaPaneTab, setUmaPaneTab] = useState<'uma1' | 'other'>('uma1');
	useEffect(() => {
		if (mode == Mode.StaCalc) setUmaPaneTab('uma1');
	}, [mode]);

	const [forceFullSpurt, toggleForceFullSpurt] = useReducer(b => !b, true);

	const loadedChartSkills = useGetter(O.chartSkills);
	const [chartSkills, setChartSkills] = useState(loadedChartSkills || []);
	const [chartMode, setChartMode] = useLens(O.chartMode);
	const [chartTableType, setChartTableType] = useState<'skills' | 'umas'>('skills');
	const [umaChartSamples, setUmaChartSamples] = useState(5);
	const umaTableCandidates = useMemo(() => getUmaTableCandidates(), []);
	const [umaTableData, setUmaTableData] = useState(new Map());
	const [lastUmaTableRun, setLastUmaTableRun] = useState<any>(null);
	const chartSkillsMap = useMemo(() => {
		const m = new Map();
		chartSkills.forEach(id => m.set(id,id));
		return m;
	}, [chartSkills]);
	const [chartSkillPickerOpen, setChartSkillPickerOpen] = useState(false);
	const [popoverSkill, setPopoverSkill] = useState('');
	const chartRunId = useRef(0);
	const [chartProgress, setChartProgress] = useState({runId: 0, active: false, completed: 0, total: 0, workers: {}});
	const compareRunId = useRef(0);
	const [compareProgress, setCompareProgress] = useState({runId: 0, active: false, completed: 0, total: 0});

	// update when state is loaded from url
	useEffect(() => {
		setTableData(getNullTableData(chartSkillsForMode(chartMode)));
	}, []);

	const [lastChartRun, setLastChartRun] = useState({
		uma: uma1,
		otherUma: uma2,
		courseId,
		racedef,
		skills: [],
		rankAwareField: false,
		simulateLanes: false,
		fieldSize: 9,
		fieldUmas: [],
		fresh: true
	});

	function isAvailableSkillUpgrade(id) {
		const ownedSkills = Array.from(uma1.skills.values());
		// Exact skills are already represented in both sides of the comparison,
		// including debuffs stored under synthetic group keys.
		if (ownedSkills.includes(id)) return false;
		// An inherited unique is redundant when its regular/evolved counterpart
		// is already owned, even though those versions use different group IDs.
		if (id[0] == '9' && ownedSkills.includes('1' + id.slice(1))) return false;
		if (id[0] == '9' && id.length > 6 && ownedSkills.includes(id.slice(2))) return false;

		const groupId = skillmeta[id].groupId;
		const group = skillGroups.get(groupId);
		if (group == null) return true;
		const candidateIndex = group.indexOf(id);
		const strongestOwnedIndex = ownedSkills.reduce((strongest, ownedId) => {
			if (skillmeta[ownedId]?.groupId != groupId) return strongest;
			return Math.max(strongest, group.indexOf(ownedId));
		}, -1);
		// skillGroups is ordered from weaker to stronger: ○, ◎, gold, pink.
		// Therefore an owned ○ excludes only itself/lower variants, while ◎ and
		// gold remain valid candidates.
		return candidateIndex > strongestOwnedIndex;
	}

	function chartSkillsForMode(mode) {
		let skills;
		switch (mode) {
		case 'selected': skills = chartSkills; break;
		case 'inherit': skills = baseSkillsToTest.filter(id => id[0] == '9'); break;
		default: skills = baseSkillsToTest;
		}
		return skills.filter(isAvailableSkillUpgrade);
	}

	function switchChartMode(e) {
		const newMode = e.currentTarget.value;
		setChartMode(newMode);
		if (newMode != chartMode) {
			setTableData(getNullTableData(chartSkillsForMode(newMode)));
			setLastChartRun({...lastChartRun, skills: [], fresh: true});
		}
	}

	function setChartSkillsAndClose(skillMap) {
		const newSkills = Array.from(skillMap.values());
		setChartSkills(newSkills);
		const m = new Map(tableData);
		newSkills.forEach(id => {
			if (chartSkills.indexOf(id) == -1) m.set(id, getNullRow(id));
		});
		setTableData(m);
		setChartSkillPickerOpen(false);
	}

	function removeChartSkill(id) {
		setChartSkills(chartSkills.filter(x => x != id));
		const m = new Map(tableData);
		m.delete(id);
		setTableData(m);
		// because we delete from tableData we should update the last run info to reflect that we no longer have the
		// data for that skill
		setLastChartRun({...lastChartRun, skills: lastChartRun.skills.filter(x => x != id)});
	}

	function clearChartSkills() {
		setChartSkills([]);
		setTableData(new Map());
		setLastChartRun({...lastChartRun, skills: [], fresh: true});
	}

	function updateChartProgress(runId, workerId, completed, total, done) {
		setChartProgress(current => {
			if (runId != chartRunId.current || current.runId != runId) return current;
			const key = String(workerId);
			const workers = {...current.workers, [key]: {completed, total, done}};
			const entries = Object.values(workers);
			const completedTotal = entries.reduce((sum, progress) => sum + progress.completed, 0);
			const reportedTotal = entries.reduce((sum, progress) => sum + progress.total, 0);
			const allDone = entries.length == 4 && entries.every(progress => progress.done);
			return {
				...current,
				workers,
				completed: Math.min(completedTotal, current.total || reportedTotal),
				total: current.total || reportedTotal,
				active: !allDone
			};
		});
	}

	function createSimulationWorker() {
		const w = new Worker('./simulator.worker.js');
		w.addEventListener('error', e => console.error('simulation worker error:', e.message, e.filename, e.lineno));
		w.addEventListener('message', function (e) {
			const {type, results, runId, workerId, completed, total, done} = e.data;
			switch (type) {
				case 'compare':
					if (runId == compareRunId.current) setCompareResults(results);
					break;
				case 'compare-progress':
					if (runId == compareRunId.current) setCompareProgress({runId, active: !done, completed, total});
					break;
				case 'hpcalc':
					setStacalcResults(results);
					break;
				case 'chart':
					if (runId == chartRunId.current) updateTableData(results);
					break;
				case 'chart-progress':
					if (runId == chartRunId.current) updateChartProgress(runId, workerId, completed, total, done);
					break;
				case 'uma-chart':
					if (runId == chartRunId.current) updateUmaTableData(results);
					break;
				case 'uma-chart-progress':
					if (runId == chartRunId.current) updateChartProgress(runId, workerId, completed, total, done);
					break;
			}
		});
		return w;
	}

	function createSimulationWorkers() {
		return Array.from({length: 4}, () => createSimulationWorker());
	}

	const [workers, setWorkers] = useState(() => createSimulationWorkers());
	useEffect(() => () => workers.forEach(worker => worker.terminate()), [workers]);

	function replaceSimulationWorkers() {
		// Chart work is synchronous inside a worker, so a cancel message would
		// remain queued behind the current batch. Termination is the only prompt
		// cancellation mechanism; replacement workers are immediately ready.
		workers.forEach(worker => worker.terminate());
		const replacement = createSimulationWorkers();
		setWorkers(replacement);
		return replacement;
	}

	const copyLinkLink = useRef(null);

	const hintLevels_GetCurrent = useInspectState(O.hintLevels);
	function doSerialize() {
		return serialize(courseId, nsamples, seed, usePosKeep, useCompeteTop, useIntChecks_, rankAwareField, simulateLanes, fieldSize,
			racedef, hintLevels_GetCurrent(), uma1, uma2, fieldUmas, debufUma,
			mode == Mode.Chart ? chartMode : null, mode == Mode.Chart && chartMode == 'selected' ? chartSkills : null
		);
	}

	function copyStateUrl(e) {
		e.preventDefault();
		doSerialize().then(hash => {
			const url = window.location.protocol + '//' + window.location.host + window.location.pathname;
			window.navigator.clipboard.writeText(url + '#' + hash);
		});
	}

	function updateCopyLinkHref(e) {
		// don't preventDefault() because we do want the context menu to show, we just want the element's href
		// to be updated so that the browser's ‘Copy Link’ functionality works as expected
		doSerialize().then(hash => {
			if (copyLinkLink.current != null) {
				copyLinkLink.current.href = '#' + hash;
			}
		});
	}

	const strings = {skillnames: {}, tracknames: TRACKNAMES_en, common: COMMON_STRINGS[props.lang], ui: UI_STRINGS[props.lang]};
	const langid = CC_GLOBAL ? 0 : +(props.lang == 'en');
	Object.keys(skillnames).forEach(id => strings.skillnames[id] = skillnames[id][langid]);

	function doComparison() {
		postEvent('doComparison', {});
		const runId = ++compareRunId.current;
		setCompareProgress({runId, active: true, completed: 0, total: 0});
		workers[0].postMessage({
			msg: 'compare',
			data: {
				runId,
				nsamples,
				course,
				racedef: racedefToParams(racedef),
				uma1: uma1,
				uma2: uma2,
				fieldUmas: fieldUmas.slice(0, Math.max(0, fieldSize - 2)),
				options: {seed, usePosKeep, useCompeteTop, useIntChecks, rankAwareField, simulateLanes, fieldSize}
			}
		});
	}

	function doStaCalc() {
		postEvent('doStaCalc', {});
		workers[0].postMessage({
			msg: 'hpcalc',
			data: {
				nsamples,
				course,
				racedef: racedefToParams(racedef),
				uma: uma1,
				debufUma,
				options: {seed, usePosKeep, useCompeteTop, useIntChecks, forceFullSpurt}
			}
		});
	}

	function runBasinnChart(uma, otherUma, params, skills) {
		const chartWorkers = replaceSimulationWorkers();
		const runId = ++chartRunId.current;
		const stageCount = rankAwareField ? 50 : 5;
		setChartProgress({runId, active: true, completed: 0, total: skills.length * stageCount, workers: {}});
		const filler = getNullTableData(skills);
		setTableData(filler);
		const nPerWorker = Math.ceil(skills.length/chartWorkers.length);
		chartWorkers.reduce((skills, w, workerIndex) => {
			w.postMessage({msg: 'chart', data: {
				skills: skills.slice(0, nPerWorker),
				runId,
				workerId: workerIndex + 1,
				course,
				racedef: params,
				uma,
				otherUma,
				options: {
					seed,
					usePosKeep,
					useCompeteTop,
					useIntChecks: false,
					rankAwareField,
					simulateLanes,
					fieldSize,
					fieldUmas: fieldUmas.slice(0, Math.max(0, fieldSize - 2))
				}
			}});
			return skills.slice(nPerWorker);
		}, skills);
	}

	function stopBasinnChart() {
		const runId = ++chartRunId.current;
		replaceSimulationWorkers();
		setChartProgress({runId, active: false, completed: 0, total: 0, workers: {}});
		// Keep completed rows visible, but make the refresh control available so
		// a stopped partial table cannot be mistaken for a completed one.
		setLastChartRun({...lastChartRun, fresh: true});
	}

	function runUmaChart() {
		const chartWorkers = replaceSimulationWorkers();
		const runId = ++chartRunId.current;
		const params = {...racedefToParams(racedef, uma1.strategy), rankAware: true, orderRange: null, numUmas: fieldSize};
		setChartProgress({runId, active: true, completed: 0, total: umaTableCandidates.length * umaChartSamples, workers: {}});
		setUmaTableData(new Map());
		setLastUmaTableRun({uma: uma1, otherUma: uma2, courseId, racedef, fieldSize,
			fieldUmas: fieldUmas.slice(0, Math.max(0, fieldSize - 2)), simulateLanes, fresh: false});
		const nPerWorker = Math.ceil(umaTableCandidates.length / chartWorkers.length);
		chartWorkers.forEach((worker, workerIndex) => worker.postMessage({msg: 'uma-chart', data: {
			candidates: umaTableCandidates.slice(workerIndex * nPerWorker, (workerIndex + 1) * nPerWorker), samples: umaChartSamples,
			runId, workerId: workerIndex + 1, course, racedef: params, uma: uma1, otherUma: uma2,
			options: {seed, usePosKeep, useCompeteTop, useIntChecks, fieldSize,
				simulateLanes, fieldUmas: fieldUmas.slice(0, Math.max(0, fieldSize - 2))}
		}}));
	}

	function doBasinnChart() {
		postEvent('doBasinnChart', {});
		const params = racedefToParams(racedef, uma1.strategy);
		const chartParams = rankAwareField ? {...params, rankAware: true, orderRange: null, numUmas: fieldSize} : params;
		const skills = getActivateableSkills(chartSkillsForMode(chartMode), uma1, course, chartParams, rankAwareField);
		setLastChartRun({
			uma: uma1,
			otherUma: uma2,
			courseId,
			racedef,
			skills,
			rankAwareField,
			simulateLanes,
			fieldSize,
			fieldUmas: fieldUmas.slice(0, Math.max(0, fieldSize - 2)),
			fresh: false
		});
		runBasinnChart(uma1, uma2, params, skills);
	}

	function doChart() {
		if (chartTableType == 'umas') {
			postEvent('doUmaChart', {});
			runUmaChart();
		} else {
			doBasinnChart();
		}
	}

	function basinnChartSelection(skillId) {
		const r = tableData.get(skillId);
		if (r.runData != null) setChartSelectionResults(r);
	}

	function addSkillFromTable(skillId) {
		postEvent('addSkillFromTable', {skillId});
		setUma1(new (O.skills.get(skillmeta[skillId].groupId))(skillId));
	}

	function showPopover(skillId) {
		postEvent('showPopover', {skillId});
		setPopoverSkill(skillId);
	}

	useEffect(function () {
		document.body.addEventListener('click', function () {
			setPopoverSkill('');
		});
	}, []);

	function rtMouseMove(pos) {
		if (chartData == null) return;
		const x = pos * course.distance;
		const i0 = binSearch(chartData.p[0], x);
		document.getElementById('rtV1').textContent = `${chartData.v[0][i0].toFixed(2)} m/s  t=${chartData.t[0][i0].toFixed(2)} s  (${chartData.hp[0][i0].toFixed(0)} hp remaining)`;
		if (chartData.t.length > 1) {
			const i1 = binSearch(chartData.p[1], x);
			document.getElementById('rtV2').textContent = `${chartData.v[1][i1].toFixed(2)} m/s  t=${chartData.t[1][i1].toFixed(2)} s  (${chartData.hp[1][i1].toFixed(0)} hp remaining)`;
		}
	}

	function rtMouseEnter() {
		if (chartData != null) {
			document.getElementById('rtV1').style.display = 'block';
			if (chartData.t.length > 1) document.getElementById('rtV2').style.display = 'block';
		}
	}

	function rtMouseLeave() {
		document.getElementById('rtV1').style.display = 'none';
		document.getElementById('rtV2').style.display = 'none';
	}

	const colors = [
		{stroke: UMA1_COLOR, fill: UMA1_COLOR.replace(/rgb\((.+?)\)/, "rgba($1, 0.7)")},
		{stroke: UMA2_COLOR, fill: UMA2_COLOR.replace(/rgb\((.+?)\)/, "rgba($1, 0.7)")}
	];
	const skillActivations = chartData == null ? [] : chartData.sk.flatMap((a,i) => {
		return Array.from(a.keys()).flatMap(id => {
			const special = SPECIAL_SKILLS.indexOf(id) > -1;
			if (!special && NO_SHOW.indexOf(skillmeta[id].iconId) > -1) return [];
			else return a.get(id).map(ar => ({
				type: RegionDisplayType.Textbox,
				color: colors[i],
				text: special ? UI_STRINGS[props.lang][id] : skillnames[id][0],
				regions: [{start: ar[0], end: ar[1] == -1 ? ar[0] + course.distance * 0.078 /* somewhat arbitrary */ : ar[1]}]
			}));
		});
	});

	const staminaTabs = useMemo(() => (
		<div class="umaTabs">
			<div class={`umaTab ${staminaEditor == 'uma' ? 'selected' : ''}`} onClick={() => setStaminaEditor('uma')}><span><Text id="ui.uma" /></span></div>
			<div class={`umaTab ${staminaEditor == 'debuffer' ? 'selected' : ''}`} onClick={() => setStaminaEditor('debuffer')}><span><Text id="ui.debuffer" /></span></div>
		</div>
	), [staminaEditor]);

	const chartEvaluationControls = mode == Mode.Chart && (
		<section id="chartEvaluationControls" aria-label="Evaluation setup">
			<div class="evaluationTabs" role="tablist" aria-label="Evaluation type">
				<button role="tab" aria-selected={chartTableType == 'skills'} class={chartTableType == 'skills' ? 'selected' : ''} onClick={() => setChartTableType('skills')}>
					<strong>Skills</strong><small>Compare added skills against the current Uma 1 build</small>
				</button>
				<button role="tab" aria-selected={chartTableType == 'umas'} class={chartTableType == 'umas' ? 'selected' : ''} onClick={() => setChartTableType('umas')}>
					<strong>Umas</strong><small>Compare each unique against a same-style no-unique baseline</small>
				</button>
			</div>
			<div class="evaluationOptions">
				{chartTableType == 'umas' ? <Fragment>
					<label class="evaluationSampleInput" for="umaChartSamples">Samples per Uma
						<input id="umaChartSamples" type="number" min="1" max="50" value={umaChartSamples} onInput={e => setUmaChartSamples(Math.max(1, Math.min(50, Math.trunc(+e.currentTarget.value) || 1)))} />
					</label>
					<p>Uses Uma 1's non-unique skills and simulation settings. Every candidate uses her default running style.</p>
				</Fragment> : <Fragment>
					<fieldset id="basinnChartSelect" aria-label="Skills to evaluate">
						<div><input type="radio" id="basinnChartSelectAll" name="basinnChartSelection" value="all" checked={chartMode == 'all'} onClick={switchChartMode} /><label for="basinnChartSelectAll"><Text id="ui.basinnchartselection.all" /></label></div>
						<div><input type="radio" id="basinnChartSelectInherit" name="basinnChartSelection" value="inherit" checked={chartMode == 'inherit'} onClick={switchChartMode} /><label for="basinnChartSelectInherit"><Text id="ui.basinnchartselection.inherit" /></label></div>
						<div><input type="radio" id="basinnChartSelectSelected" name="basinnChartSelection" value="selected" checked={chartMode == 'selected'} onClick={switchChartMode} /><label for="basinnChartSelectSelected"><Text id="ui.basinnchartselection.selected" /></label></div>
					</fieldset>
					<div id="basinnChartSelectButtons" class={chartMode == 'selected' ? '' : 'hidden'}>
						<button class="stdBtn btnType2" onClick={clearChartSkills}><Text id="ui.basinnchartselection.clear" /></button>
						<button class="stdBtn btnType1" onClick={setChartSkillPickerOpen.bind(null, true)}><Text id="ui.basinnchartselection.addskill" /></button>
					</div>
				</Fragment>}
				<button class="stdBtn btnType1 evaluationRun" onClick={doChart}>{chartProgress.active ? 'Restart' : 'Run'} {chartTableType == 'umas' ? 'Uma evaluation' : 'skill evaluation'}</button>
			</div>
			{chartProgress.active && <div id="chartProgress" role="status" aria-live="polite">
				<div class="chartProgressHeader"><span>{chartTableType == 'umas' ? 'Simulating umas…' : 'Simulating skills…'}</span><span>{chartProgress.total > 0 ? Math.floor(100 * chartProgress.completed / chartProgress.total) : 0}%</span><button class="chartProgressStop" onClick={stopBasinnChart}>Stop</button></div>
				<progress max={chartProgress.total || 1} value={Math.min(chartProgress.completed, chartProgress.total || 1)} />
			</div>}
			<div class={`horseSkillPickerOverlay ${chartSkillPickerOpen ? "open" : ""}`} onClick={setChartSkillPickerOpen.bind(null, false)} />
			<div class={`horseSkillPickerWrapper ${chartSkillPickerOpen ? "open" : ""}`}>
				<SkillList ids={nonPurpleSkills.filter(isAvailableSkillUpgrade)} selectionMode="all" selected={chartSkillsMap} setSelected={setChartSkillsAndClose} isOpen={chartSkillPickerOpen} />
			</div>
		</section>
	);

	let resultsPane;
	if (mode == Mode.Compare && results.length > 0) {
		const mid = Math.floor(results.length / 2);
		const median = results.length % 2 == 0 ? (results[mid-1] + results[mid]) / 2 : results[mid];
		const mean = results.reduce((a,b) => a+b, 0) / results.length;
		resultsPane = (
			<div id="resultsPaneWrapper" class="compareResultsWrapper">
				<div id="compareResultsTop">
				<div id="resultsPane" class="mode-compare">
					<table id="resultsSummary">
						<tfoot>
							<tr>
								{Object.entries({
									minrun: ['Minimum', 'Set chart display to the run with minimum bashin difference'],
									maxrun: ['Maximum', 'Set chart display to the run with maximum bashin difference'],
									meanrun: ['Mean', 'Set chart display to a run representative of the mean bashin difference'],
									medianrun: ['Median', 'Set chart display to a run representative of the median bashin difference']
								}).map(([k,label]) =>
									<th scope="col" class={displaying == k ? 'selected' : ''} title={label[1]} onClick={() => setChartData(k)}>{label[0]}</th>
								)}
							</tr>
						</tfoot>
						<tbody>
							<tr>
								<td onClick={() => setChartData('minrun')}>{results[0].toFixed(2)}<span class="unit-basinn"><Text id="ui.lengthsunit" /></span></td>
								<td onClick={() => setChartData('maxrun')}>{results[results.length-1].toFixed(2)}<span class="unit-basinn"><Text id="ui.lengthsunit" /></span></td>
								<td onClick={() => setChartData('meanrun')}>{mean.toFixed(2)}<span class="unit-basinn"><Text id="ui.lengthsunit" /></span></td>
								<td onClick={() => setChartData('medianrun')}>{median.toFixed(2)}<span class="unit-basinn"><Text id="ui.lengthsunit" /></span></td>
							</tr>
						</tbody>
					</table>
					<div id="resultsHelp"><MarkupText id="ui.resultshelp" /></div>
					<WinRateSummary winRate={runData.winRate} fieldWinRate={runData.fieldWinRate} />
					<Histogram width={500} height={333} data={results} splitColors={true} />
				</div>
				<div id="infoTables">
					<Localizer>
						<ResultsTable caption={<Text id="ui.uma1" />} class="uma1" chartData={chartData} idx={0} spurtRate={runData.nspurt[0] / results.length} />
						<ResultsTable caption={<Text id="ui.uma2" />} class="uma2" chartData={chartData} idx={1} spurtRate={runData.nspurt[1] / results.length} />
					</Localizer>
				</div>
				</div>
				{runData.medianrun?.fieldReplay && <RaceReplay replay={runData.medianrun.fieldReplay} course={course}
					simulateLanes={!!runData.experimental?.simulateLanes} />}
				{runData.monteCarlo && <MonteCarloAnalysis stats={runData.monteCarlo} courseDistance={course.distance} />}
			</div>
		);
	} else if (mode == Mode.StaCalc && results.remainingHp != null) {
		resultsPane = (
			<div id="resultsPaneWrapper">
				<div id="resultsPane" class="mode-stacalc">
					<StaCalcResults course={course} uma={uma1} results={results} nspurt={runData.nspurt} displayedRun={O.displayedRun} Histogram={Histogram} />
				</div>
			</div>
		);
	} else if (mode == Mode.Chart) {
		if (chartTableType == 'umas') {
			const currentFieldUmas = fieldUmas.slice(0, Math.max(0, fieldSize - 2));
			const fieldChanged = lastUmaTableRun == null || fieldSize != lastUmaTableRun.fieldSize || simulateLanes != lastUmaTableRun.simulateLanes ||
				currentFieldUmas.length != lastUmaTableRun.fieldUmas.length || currentFieldUmas.some((uma, index) => !horseEquals(uma, lastUmaTableRun.fieldUmas[index]));
			const dirty = lastUmaTableRun == null || !horseEquals(uma1, lastUmaTableRun.uma) || !horseEquals(uma2, lastUmaTableRun.otherUma) ||
				courseId != lastUmaTableRun.courseId || !shallowEquals(racedef, lastUmaTableRun.racedef) || fieldChanged || lastUmaTableRun.fresh;
			resultsPane = <div id="resultsPaneWrapper"><div id="resultsPane" class="mode-chart">{chartEvaluationControls}<div id="basinnChartWrapperWrapper">
				<UmaChart data={Array.from(umaTableData.values())} candidates={umaTableCandidates} dirty={dirty} />
				<button id="basinnChartRefresh" class={dirty ? '' : 'hidden'} onClick={doChart}>⟲</button>
			</div></div></div>;
		} else {
		const currentFieldUmas = fieldUmas.slice(0, Math.max(0, fieldSize - 2));
		const fieldChanged = rankAwareField != lastChartRun.rankAwareField || simulateLanes != lastChartRun.simulateLanes || fieldSize != lastChartRun.fieldSize ||
			currentFieldUmas.length != lastChartRun.fieldUmas.length ||
			currentFieldUmas.some((uma, index) => !horseEquals(uma, lastChartRun.fieldUmas[index]));
		const dirty = !horseEquals(uma1, lastChartRun.uma) || !horseEquals(uma2, lastChartRun.otherUma) || courseId != lastChartRun.courseId || !shallowEquals(racedef, lastChartRun.racedef) || fieldChanged || (chartMode == 'selected' ? chartSkills.some(id => lastChartRun.skills.indexOf(id) == -1) : lastChartRun.fresh);
		resultsPane = (
			<div id="resultsPaneWrapper">
				<div id="resultsPane" class="mode-chart">
					{chartEvaluationControls}
					<div id="basinnChartWrapperWrapper">
						<BasinnChart data={Array.from(tableData.values())} hasSkills={lastChartRun.uma.skills}
							dirty={dirty}
							hintLevels={O.hintLevels}
							displayedRun={O.displayedRun}
							dismissable={chartMode == 'selected'}
							onSelectionChange={basinnChartSelection}
							onDblClickRow={addSkillFromTable}
							onInfoClick={showPopover}
							onSkillDismiss={removeChartSkill} />
						<button id="basinnChartRefresh" class={dirty ? '' : 'hidden'} onClick={doBasinnChart}>⟲</button>
					</div>
				</div>
			</div>
		);
		}
	} else if (CC_GLOBAL) {
		resultsPane = (
			<div id="resultsPaneWrapper">
				<div id="resultsPane">
					<IntroText />
				</div>
			</div>
		);
	} else {
		resultsPane = null;
	}

	return (
		<Language.Provider value={props.lang}>
			<IntlProvider definition={strings}>
				<div id="umaPane">
					{mode != Mode.StaCalc && <div class="umaPaneTabs" role="tablist" aria-label="Uma editor">
						<button role="tab" aria-selected={umaPaneTab == 'uma1'} class={umaPaneTab == 'uma1' ? 'selected' : ''} onClick={() => setUmaPaneTab('uma1')}>Uma 1</button>
						<button role="tab" aria-selected={umaPaneTab == 'other'} class={umaPaneTab == 'other' ? 'selected' : ''} onClick={() => setUmaPaneTab('other')}>Other Umas</button>
					</div>}
					<div class={`umaEditorPanel ${mode != Mode.StaCalc ? (umaPaneTab == 'uma1' ? 'selected' : '') : (staminaEditor == 'uma' ? 'selected' : '')}`}>
						<HorseDef key={uma1.outfitId} state={O.uma1} aptitudesMode="simulation" course={course} showPolicyEd={true} tabstart={() => 4}>
							{mode == Mode.StaCalc ? staminaTabs : <Text id="ui.uma1" />}
						</HorseDef>
					</div>
					{mode != Mode.StaCalc && <div class={`umaEditorPanel ${umaPaneTab == 'other' ? 'selected' : ''}`}>
						<OpponentRoster key={`other-${umaPaneTab}`} embedded course={course} courseId={courseId} fieldSize={fieldSize} setFieldSize={setFieldSize} uma1={uma1} uma2={uma2} fieldEnabled={rankAwareField} />
					</div>}
					{mode == Mode.StaCalc && <div class={`umaEditorPanel ${staminaEditor == 'debuffer' ? 'selected' : ''}`}>
						<HorseDef key={debufUma.outfitId} state={O.debufUma} aptitudesMode="simulation" course={course} showPolicyEd={true} tabstart={() => 4 + horseDefTabs()}>
							{staminaTabs}
						</HorseDef>
					</div>}
				</div>
				<div id="nonUmaPanes">
					<div id="midPane" class={chartData ? 'hasResults' : ''}>
						<RaceTrack courseid={courseId} width={960} height={240} xOffset={20} yOffset={15} yExtra={20} mouseMove={rtMouseMove} mouseEnter={rtMouseEnter} mouseLeave={rtMouseLeave} regions={skillActivations}>
							<VelocityLines data={chartData} courseDistance={course.distance} width={960} height={250} xOffset={20} showHp={showHp} />
							<g id="rtMouseOverBox">
								<text id="rtV1" x="25" y="10" fill="#2a77c5" font-size="10px" style="display:none"></text>
								<text id="rtV2" x="25" y="20" fill="#c52a2a" font-size="10px" style="display:none"></text>
							</g>
						</RaceTrack>
						<div id="buttonsRow">
							<TrackSelect key={courseId} courseid={courseId} setCourseid={setCourseId} tabindex={2} />
							<RacePresets courseId={O.courseId} racedef={O.racedef} />
							<div class="spacer" />
							<TimeOfDaySelect t={O.racedef.time} />
							<div>
								<GroundSelect g={O.racedef.ground} />
								<WeatherSelect w={O.racedef.weather} />
							</div>
							<SeasonSelect s={O.racedef.season} />
						</div>
						<div id="modeBar">
							<button class={`modeBtn${mode == Mode.Compare ? ' modeBtnActive' : ''}`} onClick={() => setMode(Mode.Compare)}><Text id="ui.mode.compare" /></button>
							<button class={`modeBtn${mode == Mode.Chart ? ' modeBtnActive' : ''}`} onClick={() => setMode(Mode.Chart)}><Text id="ui.mode.chart" /></button>
							<button class={`modeBtn${mode == Mode.StaCalc ? ' modeBtnActive' : ''}`} onClick={() => setMode(Mode.StaCalc)}><Text id="ui.mode.stacalc" /></button>
						</div>
						{resultsPane}
					</div>
					<div id="sidebar">
						<div class="sidebarSetting"><label for="nsamples"><Text id="ui.sidebar.samples" /></label>
							<input type="number" id="nsamples" min="1" max="10000" value={nsamples} onInput={(e) => setSamples(+e.currentTarget.value)} />
						</div>
						<div class="sidebarSetting"><label for="seed"><Text id="ui.sidebar.seed" /></label>
						<div id="seedWrapper">
							<input type="number" id="seed" value={seed} onInput={(e) => setSeed(+e.currentTarget.value)} />
							<button title="Randomize seed" onClick={() => setSeed(Math.floor(Math.random() * (-1 >>> 0)) >>> 0)}>🎲</button>
						</div></div>
						<div>
							<label for="poskeep"><Text id="ui.sidebar.poskeep" /></label>
							<input type="checkbox" id="poskeep" checked={usePosKeep} onClick={togglePosKeep} />
						</div>
						<div>
							<label for="competetop"><Text id="ui.sidebar.competetop" /></label>
							<input type="checkbox" id="competetop" checked={useCompeteTop} onClick={toggleCompeteTop} />
						</div>
						<div>
							<label for="intchecks"><Text id="ui.sidebar.intchecks" /></label>
							<input type="checkbox" id="intchecks" checked={useIntChecks} onClick={toggleIntChecks} disabled={mode == Mode.StaCalc} />
						</div>
						<div>
							<label for="showhp"><Text id="ui.sidebar.showhp" /></label>
							<input type="checkbox" id="showhp" checked={showHp} onClick={toggleShowHp} />
						</div>
		{mode != Mode.StaCalc && <div title="Shared-clock field simulation with editable runners, live ranks, longitudinal proximity, and targeted effects. Lane-qualified blocking conditions use a documented distance-only approximation; lanes and physical blocking slowdown are not modeled. Experimental skill-table rows use adaptive 5/10/20/30/50-sample checkpoints and stop when absolute or relative variance is low, the mean and variance stabilize, or the paired mean's 95% confidence interval is sufficiently narrow. Random skills receive a 20-sample safeguard when their track-specific effects can plausibly matter; irrelevant early/mid-race acceleration keeps the five-sample fast path. Legacy mode uses 200 samples.">
							<label for="rankAwareField">Experimental full-field ranks</label>
							<input type="checkbox" id="rankAwareField" checked={rankAwareField} onClick={toggleRankAwareField} />
						</div>}
		{mode != Mode.StaCalc && <div title="Simulate continuous lateral position, lane target selection, and documented front/side blocking geometry. Physical blocking slowdown remains disabled.">
							<label for="simulateLanes">Experimental lane movement</label>
							<input type="checkbox" id="simulateLanes" checked={simulateLanes} onClick={toggleSimulateLanes} disabled={!rankAwareField} />
						</div>}
						{mode != Mode.StaCalc && <div class={!rankAwareField ? 'optionUnavailable' : ''}>
							<label for="fieldSize">Field size</label>
							<input type="number" id="fieldSize" min="2" max="18" value={fieldSize} onInput={(e) => setFieldSize(Math.max(2, Math.min(18, +e.currentTarget.value)))} disabled={!rankAwareField} />
						</div>}
						{
							[
								<button id="run" class="stdBtn btnType1" onClick={doComparison} tabindex={1}><Text id="ui.sidebar.run.compare" /></button>,
								null,
								<button id="run" class="stdBtn btnType1" onClick={doStaCalc} tabindex={1}><Text id="ui.sidebar.run.stacalc" /></button>,
							][mode]
						}
		{mode == Mode.Compare && compareProgress.active && <div id="chartProgress" role="status" aria-live="polite">
			<div class="chartProgressHeader"><span>Simulating races…</span><span>{compareProgress.total > 0 ? Math.floor(100 * compareProgress.completed / compareProgress.total) : 0}%</span></div>
			<progress max={compareProgress.total || 1} value={Math.min(compareProgress.completed, compareProgress.total || 1)} />
		</div>}
						<a ref={copyLinkLink} href="#" onClick={copyStateUrl} onContextMenu={updateCopyLinkHref}><Text id="ui.sidebar.copylink" /></a>
						<div class="spacer" />
						{
							mode == Mode.StaCalc &&
								<div id="extendedOptionsRow">
									<div>
										<label for="stacalcForceMaxSpurt">Force full spurt</label>
										<input type="checkbox" id="stacalcForceMaxSpurt" checked={forceFullSpurt} onClick={toggleForceFullSpurt} />
									</div>
								</div>
						}
					</div>
				</div>
				{popoverSkill && <BasinnChartPopover skillid={popoverSkill} results={tableData.get(popoverSkill).results} courseDistance={course.distance} />}
			</IntlProvider>
		</Language.Provider>
	);
}

function App(props) {
	const state = makeState(() => ({
		racedef: DEFAULT_PRESET.racedef,
		nsamples: DEFAULT_SAMPLES,
		seed: DEFAULT_SEED,
		usePosKeep: true,
		useCompeteTop: true,
		useIntChecks: false,
		rankAwareField: false,
		simulateLanes: false,
		fieldSize: 9,
		showHp: false,
		uma1: DEFAULT_HORSE_STATE,
		uma2: DEFAULT_HORSE_STATE,
		fieldUmas: makeDefaultOpponentRoster(DEFAULT_HORSE_STATE, DEFAULT_HORSE_STATE),
		debufUma: DEFAULT_HORSE_STATE,
		courseId: DEFAULT_COURSE_ID,
		displayedRun: 'meanrun',
		tableData: getNullTableData(baseSkillsToTest),
		hintLevels: new Map(allZeroHints),
		chartMode: 'all',
		chartSkills: null
	}));

	// key shenanigans to force unmount/remount when loading state from URL so that sub-components can have their own
	// derived state based on the initial state we load
	const [key, setKey] = useState(false);
	function loadState() {
		if (window.location.hash) {
			deserialize(window.location.hash.slice(1)).then(o => {
				state.setState(Object.assign({}, state.ref.current.state, o));
				setKey(!key);
			});
		}
	}

	useEffect(function () {
		loadState();
		window.addEventListener('hashchange', loadState);
	}, []);

	return (
		<State.Provider value={state}>
			<Umalator key={key} lang={props.lang} />
		</State.Provider>
	);
}

initTelemetry();

// there's an annoying site that embeds the umalator surrounded by a bunch of ads
try {
	// try to detect if we're in a cross-domain iframe by deliberately triggering a CORS violation (we can't inspect any
	// properties of the parent page directly, but we can exploit that to determine if we're being embedded)
	window.parent && window.parent.location.hostname;
	render(<App lang={CC_GLOBAL?"en-global":"en-ja"} />, document.getElementById('app'));
} catch (e) {
	if (e instanceof DOMException) {
		document.getElementById('app').innerHTML = '<p style="font-size:22px"><span style="border:3px solid orange;border-radius:3em;color:orange;display:inline-block;font-weight:bold;height:1.8em;line-height:1.8em;text-align:center;width:1.8em">!</span> You are probably on some kind of scummy ad-infested rehosting site. The official URL for the Umalator is <a href="https://alpha123.github.io/uma-tools/umalator-global/" target="_blank">https://alpha123.github.io/uma-tools/umalator-global/</a>.</p>'
	} else {
		throw e;
	}
}
