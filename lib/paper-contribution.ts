// Contribution is independent of the paper's physics island and legacy role.
export const PAPER_CONTRIBUTIONS = [
  {
    id: 'candidate',
    label: 'Candidate / explanation',
    description: 'Proposes or develops an explanation of the recoil.',
  },
  {
    id: 'new-bound',
    label: 'New bound',
    description:
      'Derives a new empirical limit or recasts data to constrain a scenario.',
  },
  {
    id: 'candidate-and-bound',
    label: 'Candidate + new bound',
    description: 'Develops an explanation and derives a new bound.',
  },
  {
    id: 'bound-reassessment',
    label: 'Bound reassessment',
    description:
      'Critiques or refines the assumptions behind an existing bound.',
  },
  {
    id: 'other',
    label: 'Other analysis',
    description:
      'Comparisons, forecasts, backgrounds, or other supporting work.',
  },
  {
    id: 'observation',
    label: 'LZ observation',
    description: 'The source experimental result.',
  },
] as const;

export type PaperContribution = (typeof PAPER_CONTRIBUTIONS)[number]['id'];

export function resolvePaperContribution(
  contribution: string,
): PaperContribution {
  return (
    PAPER_CONTRIBUTIONS.find((item) => item.id === contribution)?.id ?? 'other'
  );
}

export function paperContributionLabel(contribution: string) {
  return (
    PAPER_CONTRIBUTIONS.find((item) => item.id === contribution)?.label ??
    'Other analysis'
  );
}
