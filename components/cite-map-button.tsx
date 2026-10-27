'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, Quote, X } from 'lucide-react';

import { mapBibtex } from '@/lib/map-citation';

export function CiteMapButton() {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied'>('idle');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);
  const headingId = useId();
  const descriptionId = useId();
  const bibtex = mapBibtex();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function copyCitation() {
    if (status === 'copying') return;
    if (timerRef.current) clearTimeout(timerRef.current);
    setStatus('copying');
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(bibtex);
      if (!mountedRef.current) return;
      setStatus('copied');
      timerRef.current = setTimeout(() => setStatus('idle'), 2200);
    } catch {
      if (!mountedRef.current) return;
      setStatus('idle');
      if (!dialogRef.current?.open) dialogRef.current?.showModal();
      textRef.current?.focus();
      textRef.current?.select();
    }
  }

  return (
    <div className="cite-map">
      <button
        ref={buttonRef}
        type="button"
        className="cite-map-button"
        onClick={copyCitation}
        disabled={status === 'copying'}
        aria-label="Cite this map: copy BibTeX"
        title={
          status === 'copied' ? 'BibTeX copied' : 'Copy map citation as BibTeX'
        }
      >
        {status === 'copied' ? (
          <Check aria-hidden="true" />
        ) : (
          <Quote aria-hidden="true" />
        )}
        <span className="cite-map-label" aria-hidden="true">
          {status === 'copied' ? 'Copied' : 'Cite this map'}
        </span>
      </button>
      <output className="sr-only" aria-live="polite">
        {status === 'copied' ? 'Map citation copied to clipboard.' : ''}
      </output>
      <dialog
        ref={dialogRef}
        className="cite-map-dialog"
        aria-labelledby={headingId}
        aria-describedby={descriptionId}
        onClose={() => buttonRef.current?.focus()}
      >
        <div className="cite-map-dialog-heading">
          <h2 id={headingId}>Cite this map</h2>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close citation"
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <p id={descriptionId}>
          Automatic copying was unavailable. Copy the BibTeX below, or download
          it.
        </p>
        <textarea
          ref={textRef}
          readOnly
          value={bibtex}
          rows={10}
          aria-label="Map citation in BibTeX"
        />
        <a
          className="cite-map-download"
          download="lz-paper-map.bib"
          href={`data:application/x-bibtex;charset=utf-8,${encodeURIComponent(bibtex)}`}
        >
          Download BibTeX
        </a>
      </dialog>
    </div>
  );
}
