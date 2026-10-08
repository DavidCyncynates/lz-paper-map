# Paper taxonomy

This document is the canonical assignment policy for the LZ paper map. It keeps
the map compact while making each island describe a coherent physical idea.

The taxonomy has eight analytical islands and one experimental anchor. Every
paper has exactly one primary category. Additional model features, test
channels, and paper roles belong in tags or other secondary metadata; they do
not create extra islands.

## Core principle

Assign a paper according to the **proximate physics responsible for the xenon
recoil**. Use `comparisons` only when the paper's main scientific object is a
comparison, inference method, or systematic that genuinely spans mechanisms.

A category records what physics the paper studies, not whether that physics is
viable. A paper that rules out a particular explanation normally remains beside
the papers proposing that explanation.

## Categories

| ID            | Display label                      | Include                                                                                                                                                                                                                      | Exclude                                                                                                                                                              |
| ------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observation` | The observation                    | The LZ experimental result reporting and characterizing the candidate.                                                                                                                                                       | Reanalyses, detector diagnostics, and phenomenology papers.                                                                                                          |
| `electroweak` | Electroweak inelastic DM           | Higgsinos, inert or scalar doublets, singlet-doublet mixtures, and other electroweak multiplets for which a few-hundred-keV transition and an off-diagonal electroweak current are central to the recoil.                    | Generic endothermic models merely embedded in a theory with electroweak particles; elastic axial neutralino scattering; model-independent comparisons.               |
| `endothermic` | Other endothermic DM               | Dark matter up-scattering to a heavier state outside the electroweak-multiplet family, including generic kinematics, dark-photon or ALP portals, composite states, sneutrinos, and related constructions.                    | Electroweak-transition models, down-scattering, absorption, and cases in which a non-virial incident flux is the main source of the recoil energy.                   |
| `exothermic`  | Exothermic DM                      | Down-scattering from a populated excited state, including work on producing, preserving, or replenishing that state when the mass splitting supplies the recoil energy.                                                      | Up-scattering and decay-produced particles whose incident boost, rather than de-excitation, supplies the recoil energy.                                              |
| `elastic`     | Elastic high-recoil DM             | Virialized halo particles that remain in the same state; the hard spectrum arises from momentum or spin dependence, nuclear interference, form factors, screening, or unusual masses and couplings.                          | Boosted or otherwise non-virial incident populations, and all state-changing processes.                                                                              |
| `boosted`     | Boosted & nonstandard fluxes       | Cosmic-ray-boosted particles, dark-sector or decay-produced energetic particles, Hawking-emitted populations, and other cases in which a non-virial flux is the main reason a high recoil is possible.                       | Atmospheric or exotic neutrinos; ordinary halo particles; an exothermic state that is merely replenished by a parent but releases its own splitting into the recoil. |
| `absorption`  | Absorption & nucleon disappearance | Dark-matter rest-mass absorption and neutron or neutron-pair disappearance or annihilation that produces a nuclear recoil without ordinary dark-matter scattering.                                                           | Elastic or inelastic scattering and neutrino-initiated reactions.                                                                                                    |
| `neutrino`    | Neutrino-initiated recoils         | An atmospheric or exotic neutrino is the incident particle that initiates the xenon recoil, including conversion through heavy neutral states.                                                                               | Solar-neutrino observations used only to constrain captured dark matter; those papers remain with the dark-matter mechanism or in `comparisons`.                     |
| `comparisons` | Comparisons & systematics          | Model-independent or genuinely cross-mechanism studies of sidebands, nuclear response, halo uncertainties, target complementarity, inference, or other discriminants, where no single proposed mechanism is the main result. | A model paper with auxiliary collider, gamma-ray, solar, or sideband tests; a constraint devoted to one physical explanation.                                        |

The observation is an anchor, not a shaded island.

## Assignment decision tree

Apply these rules in order.

1. **Check relevance.** The paper must substantially interpret, calculate,
   constrain, or discriminate the LZ high-recoil candidate. A passing mention or
   reuse of an LZ-motivated mass scale is not sufficient. Flag marginal cases
   for human review instead of inventing a catch-all category.
2. **Identify the experimental anchor.** Assign only the LZ observation paper
   itself to `observation`.
3. **Identify genuinely cross-cutting work.** Use `comparisons` when the central
   result compares multiple mechanisms or develops a mechanism-independent
   systematic, response calculation, or inference method. Do not use it merely
   because a model is constrained.
4. **Identify the incident process.** Use `neutrino` for an incoming neutrino
   and `absorption` for rest-mass absorption or nucleon disappearance.
5. **Identify a nonstandard flux.** Use `boosted` when the incident particle's
   non-virial energy distribution is the essential reason for the high recoil.
6. **Identify electroweak-transition models.** Use `electroweak` for an
   inelastic electroweak multiplet or singlet-doublet transition central to the
   signal.
7. **Identify the state transition.** Use `endothermic` for up-scattering and
   `exothermic` for down-scattering.
8. **Otherwise use elastic recoil physics.** Use `elastic` only when the dark
   particle remains in the same state and the incident population is not
   non-virial.

## Tie-break rules

1. Classify from the paper's central calculation and conclusion, not from title
   keywords or the first model named in the abstract.
2. Prefer the proximate recoil mechanism over the ultraviolet completion,
   production history, or an auxiliary observable.
3. Between `boosted` and a scattering category, ask where the energy producing
   the high recoil comes from. A non-virial incident flux selects `boosted`; a
   released mass splitting selects `exothermic`.
4. Between `electroweak` and `endothermic`, use `electroweak` only when the
   electroweak representation and transition current are essential, rather than
   incidental UV ingredients.
5. Between a mechanism and `comparisons`, use the mechanism when the paper
   develops or tests one explanation. Use `comparisons` when two or more
   explanations receive comparable treatment, or when the main output is a
   broadly applicable systematic or discriminator.
6. A negative conclusion does not move a paper to `comparisons`. Classify the
   physical scenario being tested unless the analysis is genuinely
   cross-mechanism.
7. If these rules do not produce a clear answer, record the case for human
   review. Do not add a new category for a single ambiguous paper.

## Secondary metadata

Primary categories should remain stable as the literature grows. Preserve
cross-cutting information through normalized secondary facets:

- **Paper role:** proposal, constraint, comparison, systematic, or contextual.
- **Model family:** Higgsino, inert doublet, singlet-doublet, dark photon,
  composite dark matter, supersymmetry, axion portal, and so on.
- **Test channel:** LZ sidebands, solar capture or neutrinos, colliders, gamma
  rays, delayed photons, other target materials, paleo-detectors, nuclear
  response, or halo modeling.
- **Cosmology or source:** thermal freeze-out, freeze-in, low reheating, cosmic
  rays, decays, Hawking emission, or an excited-state population.
- **Relevance:** direct, contextual, or marginal. Marginal papers should be
  reviewed before appearing on the default map.

A secondary signal never changes the primary island by itself. For example, an
endothermic model predicting a gamma-ray line remains `endothermic`, with a
gamma-ray test-channel facet.

## Future additions and reassessments

- Assign new papers using this document before choosing coordinates.
- Record one primary category and as many normalized secondary facets as the
  paper warrants.
- Reassess a primary category when a new version changes the central mechanism,
  not merely when it adds a constraint or prediction.
- Review category health when an island becomes either very small or too broad.
  Split only when the proposed subgroups have a crisp physical boundary and are
  likely to remain populated; merge only when the distinction no longer helps
  a researcher understand the recoil physics.
- Keep the total near the present nine categories. Adding a category requires a
  corpus-level rationale, not a single unusual paper.
- Store one-time bulk changes in `data/taxonomy-migrations/`; do not rewrite an
  old audit after it has been applied.

The 2026-10-08 reassessment is recorded in
`data/taxonomy-migrations/2026-10-08-primary-taxonomy-audit.json`.
