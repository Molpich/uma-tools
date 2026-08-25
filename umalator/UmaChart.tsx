import { h } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { Text } from 'preact-i18n';

import icons from '../icons.json';
import skillnames from '../uma-skill-tools/data/skillnames.json';
import { uniqueSkillForUma } from '../components/HorseDefTypes';
import { UmaTableCandidate } from './uma-table';
import { STRATEGY_NAMES } from './strategy-names';

import './BasinnChart.css';

function formatPerformance(value) {
	return Number.isFinite(value) ? `${value.toFixed(2).replace('-0.00', '0.00')} L` : '--';
}

export function UmaChart(props: {data: any[], candidates: UmaTableCandidate[], dirty: boolean}) {
	const [sort, setSort] = useState<'mean' | 'max' | 'fieldWinRate'>('mean');
	const candidates = useMemo(() => new Map(props.candidates.map(candidate => [candidate.outfitId, candidate])), [props.candidates]);
	const rows = useMemo(() => props.data.slice().sort((a, b) => b[sort] - a[sort]), [props.data, sort]);
	const header = (key, text) => <span onClick={() => setSort(key)}>{text}{sort == key ? ' ▼' : ''}</span>;
	return <div class={`basinnChartWrapper${props.dirty ? ' dirty' : ''}`}>
		<table class="basinnChart umaChart">
			<thead><tr>
				<th>{header('mean', 'Uma')}</th>
				<th>{header('mean', 'Mean vs no unique')}</th>
				<th>{header('max', 'Maximum')}</th>
				<th>{header('fieldWinRate', 'Field win rate')}</th>
				<th>Samples</th>
			</tr></thead>
			<tbody>{rows.map(row => {
				const candidate = candidates.get(row.id);
				const unique = uniqueSkillForUma(row.id, 3);
				return <tr key={row.id}>
					<td><div class="chartSkillName"><img src={`/uma-tools/icons/chara/${icons[row.id]?.[1]}.png`} loading="lazy" />
						<span>{candidate?.name}<small>{candidate?.epithet} · {STRATEGY_NAMES[candidate?.strategy] || candidate?.strategy}<br />{skillnames[unique]?.[0]}</small></span></div></td>
					<td>{formatPerformance(row.mean)}</td><td>{formatPerformance(row.max)}</td>
					<td>{`${(100 * row.fieldWinRate).toFixed(1)}%`}</td><td>{row.results.length}</td>
				</tr>;
			})}</tbody>
		</table>
	</div>;
}
