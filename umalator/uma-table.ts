import umas from '../umas.json';
import skillmeta from '../skill_meta.json';
import skilldata from '../uma-skill-tools/data/skill_data.json';
import { HorseState, uniqueSkillForUma } from '../components/HorseDefTypes';

const DefaultStrategies: HorseState['strategy'][] = ['Nige', 'Nige', 'Senkou', 'Sasi', 'Oikomi'];

function threeStarUniqueId(outfitId: string) {
	const character = +outfitId.slice(1, -2), outfit = +outfitId.slice(-2);
	return (100000 + 10000 * (outfit - 1) + character * 10 + 1).toString();
}

export interface UmaTableCandidate {
	outfitId: string
	name: string
	epithet: string
	strategy: HorseState['strategy']
}

export function getUmaTableCandidates(): UmaTableCandidate[] {
	return Object.entries(umas).flatMap(([umaId, uma]: [string, any]) =>
		Object.entries(uma.outfits).flatMap(([outfitId, outfit]: [string, any]) => {
			// A few recently added outfits do not yet have extracted unique-skill
			// data. Omit them rather than treating a missing unique as no skill.
			if (!(threeStarUniqueId(outfitId) in skilldata)) return [];
			return [{
			outfitId,
			name: uma.name[1] || uma.name[0],
			epithet: outfit.epithet,
			strategy: DefaultStrategies[outfit.strategy] || 'Senkou'
			}];
		}));
}

/** Apply Uma 1's build to an outfit, replacing only its normal unique and style. */
export function buildUmaTableCandidate(base: HorseState, candidate: UmaTableCandidate): HorseState {
	const previousUnique = base.outfitId ? uniqueSkillForUma(base.outfitId, base.starCount) : '';
	const skills = new Map(base.skills);
	if (previousUnique) skills.delete(skillmeta[previousUnique].groupId);
	const unique = uniqueSkillForUma(candidate.outfitId, 3);
	skills.set(skillmeta[unique].groupId, unique);
	const samplePolicies = new Map(base.samplePolicies);
	if (previousUnique) samplePolicies.delete(previousUnique);
	return {...base, outfitId: candidate.outfitId, starCount: 3, uniqueLv: 1,
		strategy: candidate.strategy, skills, samplePolicies};
}

/** Same build/style control used to measure the candidate unique's contribution. */
export function buildUmaTableBaseline(candidate: HorseState): HorseState {
	const unique = uniqueSkillForUma(candidate.outfitId, candidate.starCount);
	const skills = new Map(candidate.skills);
	skills.delete(skillmeta[unique].groupId);
	const samplePolicies = new Map(candidate.samplePolicies);
	samplePolicies.delete(unique);
	return {...candidate, outfitId: '', skills, samplePolicies};
}
