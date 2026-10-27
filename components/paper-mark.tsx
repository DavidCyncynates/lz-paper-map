import { resolvePaperContribution } from '@/lib/paper-contribution';

// Use the same silhouette on the map, in the list, and in the legend. The
// interior scales with the circle rather than relying on tiny border dashes.
export function PaperMark({ contribution: value }: { contribution: string }) {
  const contribution = resolvePaperContribution(value);
  const filled = contribution === 'candidate' || contribution === 'observation';
  return (
    <svg
      className="paper-mark"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="12"
        cy="12"
        r="10.5"
        fill={filled ? 'currentColor' : 'var(--mark-empty)'}
      />
      {contribution === 'candidate-and-bound' && (
        <path d="M12 1.5a10.5 10.5 0 0 0 0 21Z" fill="currentColor" />
      )}
      {contribution === 'bound-reassessment' && (
        <path
          d="M3.8 8h16.4M3.8 16h16.4"
          stroke="currentColor"
          strokeWidth="3.5"
        />
      )}
      {contribution === 'other' && (
        <circle cx="12" cy="12" r="3.3" fill="currentColor" />
      )}
      <circle
        cx="12"
        cy="12"
        r="10.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      {contribution === 'observation' && (
        <text x="12" y="15" textAnchor="middle" className="paper-mark-lz">
          LZ
        </text>
      )}
    </svg>
  );
}
