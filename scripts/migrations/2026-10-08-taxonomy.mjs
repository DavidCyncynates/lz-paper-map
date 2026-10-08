import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const landscapePath = join(process.cwd(), 'data', 'landscape.json');
const sourceText = process.argv.includes('--source-head')
  ? execFileSync('git', ['show', 'HEAD:data/landscape.json'], {
      encoding: 'utf8',
    })
  : readFileSync(landscapePath, 'utf8');
const source = JSON.parse(sourceText);

const primaryOverrides = new Map(
  Object.entries({
    2609.02775: 'electroweak',
    2609.02994: 'comparisons',
    2609.04175: 'electroweak',
    2609.04673: 'comparisons',
    2609.05291: 'comparisons',
    '2609.06640': 'endothermic',
    '2609.06750': 'endothermic',
    2609.06756: 'boosted',
    '2609.06760': 'comparisons',
    '2609.06890': 'boosted',
    2609.07742: 'boosted',
    2609.07807: 'electroweak',
    2609.08712: 'electroweak',
    '2609.09230': 'comparisons',
    2609.10453: 'endothermic',
    2609.10636: 'endothermic',
    2609.10662: 'comparisons',
    '2609.11600': 'boosted',
    2609.11833: 'comparisons',
    2609.14799: 'comparisons',
    2609.15321: 'comparisons',
    2609.15413: 'comparisons',
    2609.15634: 'comparisons',
    2609.15782: 'comparisons',
    2609.15985: 'comparisons',
    2609.16529: 'comparisons',
    2609.19174: 'electroweak',
    2609.21444: 'comparisons',
    2609.21823: 'elastic',
    2609.24982: 'boosted',
    2609.26698: 'comparisons',
    '2609.26870': 'electroweak',
    2609.28218: 'electroweak',
    2609.29462: 'boosted',
    2609.33952: 'endothermic',
    '2609.35650': 'comparisons',
    2609.35737: 'comparisons',
    2609.36184: 'comparisons',
    2609.37545: 'boosted',
    2609.38316: 'electroweak',
    2609.40234: 'comparisons',
    2610.06756: 'elastic',
    2610.09753: 'electroweak',
  }),
);

const renamedPrimary = new Map([
  ['higgsino', 'electroweak'],
  ['multimessenger', 'comparisons'],
  ['constraints', 'comparisons'],
]);

const islands = [
  {
    id: 'observation',
    label: 'The observation',
    shortLabel: 'LZ result',
    kicker: '248 keV candidate',
    summary:
      'LZ reports one nuclear-recoil candidate at 248 ± 23 (stat) ± 23 (sys) keV in 2.84 tonne-years, with maximum local and global significances of 3.4σ and 2.6σ.',
    color: '#354a62',
    x: 44,
    y: 40,
    width: 12,
    height: 20,
  },
  {
    id: 'absorption',
    label: 'Absorption & nucleon disappearance',
    shortLabel: 'Absorption / disappearance',
    kicker: 'rest mass → recoil',
    summary:
      'Rest-mass absorption and neutron-disappearance mechanisms produce a line-like recoil without ordinary halo scattering, including roughly 247 MeV fermionic-dark-matter absorption and invisible neutron or neutron-pair disappearance in xenon.',
    color: '#8d6b51',
    x: 10,
    y: 11,
    width: 25,
    height: 28,
  },
  {
    id: 'boosted',
    label: 'Boosted & nonstandard fluxes',
    shortLabel: 'Boosted / non-virial',
    kicker: 'non-virial projectiles',
    summary:
      'Cosmic rays, dark-sector decays, Hawking emission, or other sources supply a non-virial incident population energetic enough to generate the high recoil; the scattering operator is secondary to the unusual flux.',
    color: '#7d7460',
    x: 11,
    y: 41,
    width: 25,
    height: 24,
  },
  {
    id: 'neutrino',
    label: 'Neutrino-initiated recoils',
    shortLabel: 'Neutrino recoils',
    kicker: 'atmospheric / exotic ν',
    summary:
      'Atmospheric or exotic neutrinos, rather than halo dark matter, initiate the xenon process; thresholds, resonant conversion, or new interactions are used to produce an isolated high-energy recoil.',
    color: '#5f8090',
    x: 9,
    y: 69,
    width: 23,
    height: 25,
  },
  {
    id: 'electroweak',
    label: 'Electroweak inelastic DM',
    shortLabel: 'Electroweak DM',
    kicker: 'split states · weak currents',
    summary:
      'Nearly degenerate electroweak states—including Higgsinos, inert doublets, singlet–doublet mixtures, and other multiplets—up-scatter with a few-hundred-keV transition central to the recoil.',
    color: '#5e7465',
    x: 60,
    y: 5,
    width: 36,
    height: 35,
  },
  {
    id: 'endothermic',
    label: 'Other endothermic DM',
    shortLabel: 'Endothermic DM',
    kicker: 'up-scattering',
    summary:
      'Dark matter outside the electroweak-multiplet family up-scatters into a heavier state, spending kinetic energy on a typically few-hundred-keV splitting and selecting the halo’s fastest particles.',
    color: '#73886f',
    x: 48,
    y: 35,
    width: 30,
    height: 29,
  },
  {
    id: 'exothermic',
    label: 'Exothermic DM',
    shortLabel: 'Exothermic DM',
    kicker: 'down-scattering',
    summary:
      'An excited dark state down-scatters and releases its mass splitting into nuclear recoil energy, reducing reliance on the Galactic high-speed tail and predicting high-energy signals in other targets.',
    color: '#a16d54',
    x: 76,
    y: 59,
    width: 21,
    height: 25,
  },
  {
    id: 'elastic',
    label: 'Elastic high-recoil DM',
    shortLabel: 'Elastic DM',
    kicker: 'hard scattering spectra',
    summary:
      'Virialized halo dark matter scatters without a state transition; momentum or spin dependence, nuclear interference, form factors, screening, or unusual masses and couplings harden the recoil spectrum.',
    color: '#8b6682',
    x: 31,
    y: 72,
    width: 21,
    height: 23,
  },
  {
    id: 'comparisons',
    label: 'Comparisons & systematics',
    shortLabel: 'Comparisons',
    kicker: 'sidebands · halos · nuclei',
    summary:
      'These papers compare several explanations or study uncertainties that cut across them, including LZ sidebands, halo structure, xenon nuclear response, other targets, and model-independent inference.',
    color: '#8d625f',
    x: 51,
    y: 72,
    width: 27,
    height: 24,
  },
];

let migratedText = sourceText;
if (/^  "taxonomyRevision":/m.test(migratedText)) {
  migratedText = migratedText.replace(
    /^  "taxonomyRevision": .*,$/m,
    '  "taxonomyRevision": "2026-10-08",',
  );
} else {
  migratedText = migratedText.replace(
    /^  "schemaVersion": 2,$/m,
    '  "schemaVersion": 2,\n  "taxonomyRevision": "2026-10-08",',
  );
}

const islandStart = migratedText.indexOf('  "islands": [');
const papersStart = migratedText.indexOf('  "papers": [');
assert.ok(islandStart >= 0 && papersStart > islandStart);
const serializedIslands = JSON.stringify(islands, null, 2)
  .split('\n')
  .map((line) => `  ${line}`)
  .join('\n');
migratedText = `${migratedText.slice(0, islandStart)}  "islands": ${serializedIslands.trimStart()},\n${migratedText.slice(papersStart)}`;

for (const paper of source.papers) {
  const primary =
    primaryOverrides.get(paper.id) ??
    renamedPrimary.get(paper.primaryIsland) ??
    paper.primaryIsland;
  const marker = `      "id": "${paper.id}",`;
  const paperStart = migratedText.indexOf(marker);
  assert.ok(paperStart >= 0, `Could not locate ${paper.id}`);
  const nextPaperStart = migratedText.indexOf(
    '\n    {\n      "id": ',
    paperStart + marker.length,
  );
  const paperEnd = nextPaperStart >= 0 ? nextPaperStart : migratedText.length;
  const paperText = migratedText.slice(paperStart, paperEnd);
  const migratedPaperText = paperText
    .replace(/"primaryIsland": "[^"]+"/, `"primaryIsland": "${primary}"`)
    .replace(
      /"islands": \[[\s\S]*?\],\n      "tags":/,
      `"islands": ["${primary}"],\n      "tags":`,
    );
  migratedText = `${migratedText.slice(0, paperStart)}${migratedPaperText}${migratedText.slice(paperEnd)}`;
}

const migrated = JSON.parse(migratedText);
const expectedPrimaryCounts = {
  observation: 1,
  electroweak: 37,
  endothermic: 33,
  exothermic: 10,
  elastic: 9,
  boosted: 7,
  absorption: 4,
  neutrino: 3,
  comparisons: 20,
};
const actualPrimaryCounts = Object.fromEntries(
  Object.keys(expectedPrimaryCounts).map((islandId) => [
    islandId,
    migrated.papers.filter((paper) => paper.primaryIsland === islandId).length,
  ]),
);
assert.deepEqual(actualPrimaryCounts, expectedPrimaryCounts);
assert.ok(
  migrated.papers.every(
    (paper) =>
      paper.islands.length === 1 && paper.islands[0] === paper.primaryIsland,
  ),
);

writeFileSync(landscapePath, migratedText);
console.log('Migrated 124 papers to taxonomy revision 2026-10-08.');
console.log(actualPrimaryCounts);
