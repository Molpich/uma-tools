import { h } from 'preact';

import './IntroText.css';

export function IntroText() {
	return (
		<div id="introtext">
			<details open={true}>
				<summary>About this fork</summary>
				<p>
					This is a personal extension of the open-source
					<a href="https://github.com/alpha123/uma-tools" target="_blank">alpha123/uma-tools</a>
					race simulator. The original simulator, solver, game data, assets, and historical
					implementation remain credited to alpha123 and the original contributors.
				</p>
				<p>
					This fork is maintained at <a href="https://github.com/Molpich/uma-tools" target="_blank">Molpich/uma-tools</a>
					and uses the forked mechanics solver at <a href="https://github.com/Molpich/uma-skill-tools" target="_blank">Molpich/uma-skill-tools</a>.
					It is not affiliated with Cygames or <i>Uma Musume: Pretty Derby</i>.
				</p>
				<ul>
					<li>Compare mode supports the original two-runner workflow plus an experimental shared-clock field model.</li>
					<li>Field mode tracks live ranks, proximity, overtake targets, activation-window events, and targeted effects for supported conditions.</li>
					<li>Replay views expose skill activations, bonus acceleration, total acceleration, ranks, and other run telemetry.</li>
					<li>The skill table includes paired comparisons, adaptive sampling, and an experimental Uma comparison view.</li>
				</ul>
				<p>
					<a href="https://github.com/Molpich/uma-tools/blob/master/UMA_SIMULATOR_EXTENSION.md" target="_blank">Read the detailed model notes and limitations</a>.
				</p>
			</details>

			<details>
				<summary>Current caveats</summary>
				<ul>
					<li>
						Legacy comparison mode still uses statistical activation placement for some
						opponent-dependent and spatial conditions. This is useful for broad comparisons,
						but not equivalent to reproducing every runner in the race.
					</li>
					<li>
						Full-field mode is more expressive but experimental. Rank, proximity, visibility,
						blocking, strategy, recovery, and overtake state are modeled where supported;
						lane selection and physical contact remain approximations, and blocking does not
						fully reproduce collision slowdown.
					</li>
					<li>
						Rare or newly introduced condition tokens may still have incomplete semantics.
						The repository audits identify unknown and allowlisted legacy conditions, but an
						audit cannot prove that a supported condition matches every game nuance.
					</li>
					<li>
						Skill cooldown and repeat-activation behavior remains limited; many skills are
						recorded as used after their first activation.
					</li>
					<li>
						Results are estimates. Increase the sample count for noisy or highly random skills,
						and treat small differences as uncertain rather than definitive.
					</li>
				</ul>
			</details>

			<details open={true}>
				<summary>Fork changelog</summary>
				<section>
					<h2>2026-08-25</h2>
					<ul>
						<li>Updated the in-app introduction and attribution for this fork.</li>
						<li>Added GitHub Pages deployment and reviewed upstream-sync automation.</li>
						<li>Added data-integrity, condition-coverage, special-scaling, and skill-branch audits.</li>
						<li>Documented full-field simulation, replay telemetry, adaptive sampling, and known limitations.</li>
					</ul>
				</section>
				<section>
					<h2>Recent simulator extensions</h2>
					<ul>
						<li>Shared-clock full-field simulation with editable additional runners and field outcomes.</li>
						<li>Generalized event-aware skill scaling for effects based on activation-window events.</li>
						<li>HP-dependent scaling, green-skill start scaling, rank-aware conditions, and overtake-aware state.</li>
						<li>Median-run replay selection and acceleration telemetry, including bonus and total acceleration.</li>
					</ul>
				</section>
				<section>
					<h2>Original project history</h2>
					<p>
						For the original simulator release history and upstream changes, see
						<a href="https://github.com/alpha123/uma-tools" target="_blank">alpha123/uma-tools</a>.
					</p>
				</section>
			</details>

			<footer id="sourcelinks">
				Fork source: <a href="https://github.com/Molpich/uma-tools" target="_blank">UI and simulator</a>, <a href="https://github.com/Molpich/uma-skill-tools" target="_blank">mechanics solver</a><br />
				Original project: <a href="https://github.com/alpha123/uma-tools" target="_blank">alpha123/uma-tools</a> and <a href="https://github.com/alpha123/uma-skill-tools" target="_blank">alpha123/uma-skill-tools</a>
			</footer>
		</div>
	);
}
