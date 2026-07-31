// The RENDERING half of the three-way rule. The DECIDING half — and the whole explanation of why
// "empty" is not the opposite of "loading" — is `collectionState.ts`. Read that first.

import type { ReactNode } from 'react';

import type { CollectionState } from './collectionState';

export interface CollectionStatusProps {
  state: CollectionState;
  /**
   * Upper-case plural for the loading line — `"THREADS"` renders `LOADING THREADS...`. Omit for a
   * bare `LOADING...`.
   */
  noun?: string;
  /** The settled-empty message. ⚠️ Only ever rendered once a read has actually completed. */
  empty?: ReactNode;
  /**
   * `fill` centres in a full-height pane, `block` sits at the top of a scrolling column, `inline`
   * is the one-line muted form used inside a card or a nav section.
   */
  layout?: 'fill' | 'block' | 'inline';
  /** Overrides the default connecting copy where a view knows something more specific. */
  connecting?: ReactNode;
}

const CONNECTING_HINT =
  'Waiting for the Polkadot host to open a chain connection. Nothing has been read yet.';

/**
 * The rendering half. Returns `null` for `ready`, so a call site is one element rather than a
 * three-armed ternary repeated in six files.
 *
 * Every class string here is copied from markup that already exists in this codebase. ⚠️ A colour
 * must be declared in the `@theme static` block in `index.css` or Tailwind generates no CSS for it
 * at all, silently — see `frontend/CLAUDE.md` § Interaction states.
 */
export function CollectionStatus({
  state,
  noun,
  empty,
  layout = 'block',
  connecting,
}: CollectionStatusProps) {
  if (state === 'ready') return null;

  if (layout === 'inline') {
    const text =
      state === 'connecting'
        ? (connecting ?? 'Connecting...')
        : state === 'loading'
          ? `Loading${noun ? ` ${noun.toLowerCase()}` : ''}...`
          : empty;
    return <div className="text-xs font-mono text-primary-700 py-2">{text}</div>;
  }

  const wrapper =
    layout === 'fill'
      ? 'flex flex-col items-center justify-center h-full text-center p-8 font-mono'
      : 'text-center py-8 font-mono';

  if (state === 'empty') {
    return (
      <div className={wrapper}>
        <div className="text-primary-600">{empty}</div>
      </div>
    );
  }

  return (
    <div className={wrapper}>
      <div className="text-primary-500">
        {state === 'connecting' ? 'CONNECTING...' : `LOADING${noun ? ` ${noun}` : ''}...`}
      </div>
      {state === 'connecting' && (
        <div className="text-primary-700 text-xs mt-1 max-w-[60ch] mx-auto">
          {connecting ?? CONNECTING_HINT}
        </div>
      )}
    </div>
  );
}
