import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = path.join(root, 'umalator-global');
const read = name => JSON.parse(fs.readFileSync(path.join(dataRoot, name), 'utf8'));

const skills = read('skill_data.json');
const skillMeta = read('skill_meta.json');
const umas = read('umas.json');
const errors = [];

for (const id of Object.keys(skills)) {
	if (!(id in skillMeta)) errors.push(`skill ${id} exists in skill_data.json but not skill_meta.json`);
}
for (const id of Object.keys(skillMeta)) {
	if (!(id in skills)) errors.push(`skill ${id} exists in skill_meta.json but not skill_data.json`);
}
for (const [umaId, uma] of Object.entries(umas)) {
	for (const [outfitId, outfit] of Object.entries(uma.outfits || {})) {
		for (const skillId of outfit.awakenings || []) {
			if (!(skillId in skills)) errors.push(`Uma ${umaId}/${outfitId} references missing skill ${skillId}`);
			if (!(skillId in skillMeta)) errors.push(`Uma ${umaId}/${outfitId} references skill ${skillId} without metadata`);
		}
	}
}

console.log(`Checked ${Object.keys(skills).length} skills, ${Object.keys(skillMeta).length} metadata entries, and ${Object.keys(umas).length} Umas.`);
if (errors.length === 0) {
	console.log('Data integrity: no orphaned skill or Uma references.');
	process.exit(0);
}

console.error(`Data integrity errors: ${errors.length}`);
for (const error of errors) console.error(`  ${error}`);
process.exitCode = 1;
