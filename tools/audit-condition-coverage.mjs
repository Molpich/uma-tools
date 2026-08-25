import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillDataPath = path.join(root, 'umalator-global', 'skill_data.json');
const skillNamesPath = path.join(root, 'umalator-global', 'skillnames.json');
const conditionsPath = path.join(root, 'uma-skill-tools', 'ActivationConditions.ts');

const skills = JSON.parse(fs.readFileSync(skillDataPath, 'utf8'));
const names = JSON.parse(fs.readFileSync(skillNamesPath, 'utf8'));
const source = fs.readFileSync(conditionsPath, 'utf8');

function conditionMapBlock(name) {
	const declaration = `export const ${name}`;
	const start = source.indexOf(declaration);
	if (start < 0) return null;

	// The solver has renamed helper functions and may add another exported
	// condition map between versions. Delimit maps by their export declarations
	// instead of depending on an unrelated helper function name.
	const nextExport = source.indexOf('\nexport const ', start + declaration.length);
	const end = nextExport >= 0 ? nextExport : source.lastIndexOf('\n});');
	if (end < 0) throw new Error(`Could not find the end of ${name}`);
	return source.slice(start, end);
}

function conditionKeys(block) {
	if (block == null) return new Set();
	// Condition maps use one property per line. Nested operator properties such
	// as filterEq are excluded because they are not valid data condition names.
	const ignored = new Set(['filterEq', 'filterNeq', 'filterLt', 'filterLte', 'filterGt', 'filterGte']);
	return new Set([...block.matchAll(/^\s*([a-z][a-z0-9_]*)\s*:/gm)]
		.map(match => match[1])
		.filter(key => !ignored.has(key)));
}

const baseConditions = conditionKeys(conditionMapBlock('Conditions'));
const fieldConditions = conditionKeys(conditionMapBlock('FieldConditions'));
const supported = new Set([...baseConditions, ...fieldConditions]);

// These exact findings are present in the current data set but deliberately
// have no complete implementation yet. Keep the skill/alternative location in
// the allowlist: a newly released skill using one of these tokens must still
// fail the audit rather than silently inheriting the old approximation.
const knownUnsupported = new Set([
	'110231:0:condition:order_rate_in50_continue',
	'200411:0:condition:last_straight_random',
	'200771:0:condition:temptation_opponent_count_behind',
	'200772:0:condition:temptation_opponent_count_behind',
	'200781:0:condition:temptation_opponent_count_infront',
	'200791:0:condition:running_style_temptation_opponent_count_nige',
	'200801:0:condition:running_style_temptation_opponent_count_senko',
	'200811:0:condition:running_style_temptation_opponent_count_sashi',
	'200821:0:condition:running_style_temptation_opponent_count_oikomi',
	'202361:0:condition:is_other_character_activate_advantage_skill',
	'202362:0:condition:is_other_character_activate_advantage_skill',
	'210131:0:condition:activate_count_later_half',
	'910231:0:condition:order_rate_in50_continue'
]);

function conditionNames(expression) {
	return expression == null ? [] : [...expression.matchAll(/[a-z][a-z0-9_]*/g)].map(match => match[0]);
}

function skillName(id) {
	return names[id]?.[1] || names[id]?.[0] || '(unnamed)';
}

const findings = new Map();
const observed = new Set();
let alternatives = 0;
for (const [id, data] of Object.entries(skills)) {
	for (const [index, alternative] of (data.alternatives || []).entries()) {
		alternatives += 1;
		for (const [where, expression] of [['condition', alternative.condition], ['precondition', alternative.precondition]]) {
			for (const name of new Set(conditionNames(expression))) {
				observed.add(name);
				if (supported.has(name)) continue;
				const key = `${id}:${index}:${where}:${name}`;
				findings.set(key, {id, index, where, name, expression});
			}
		}
	}
}

console.log(`Checked ${Object.keys(skills).length} skills and ${alternatives} alternatives.`);
console.log(`Known condition names: ${supported.size} (${baseConditions.size} base, ${fieldConditions.size} field overrides).`);

const findingKey = finding => `${finding.id}:${finding.index}:${finding.where}:${finding.name}`;
const errors = [...findings.values()].filter(finding => !knownUnsupported.has(findingKey(finding)));
const warnings = [...findings.values()].filter(finding => knownUnsupported.has(findingKey(finding)));

if (observed.has('is_overtake')) {
	console.log('is_overtake: registered (legacy mode uses its existing proxy; field mode uses live overtake-target state).');
}

if (warnings.length > 0) {
	console.warn(`Known but incomplete condition names: ${warnings.length} findings.`);
	for (const finding of warnings) {
		console.warn(`  ${finding.id}  ${skillName(finding.id)}  alternative ${finding.index + 1}, ${finding.where}: ${finding.name}`);
	}
}

if (errors.length === 0) {
	console.log('Unknown condition names: none');
	process.exit(0);
}

console.error(`Unknown condition names: ${errors.length}`);
for (const finding of errors) {
	console.error(`  ${finding.id}  ${skillName(finding.id)}  alternative ${finding.index + 1}, ${finding.where}: ${finding.name}`);
	console.error(`    ${finding.expression}`);
}
process.exitCode = 1;
