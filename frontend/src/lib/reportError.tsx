// The one call every catch block should make.
//
// `reportError('create thread', err)` records the error durably (settings → RECENT ERRORS) and shows a
// short toast whose whole surface is a "tap to copy the full text" affordance. See `errors.ts` for why
// the detail must live somewhere other than the toast.

import toast from 'react-hot-toast';
import { copyText, formatEntry, recordError } from './errors';

/**
 * @param context what the user was doing, in their words — "create thread", not "handleSubmit".
 * @returns the recorded entry, in case the caller wants the summary for inline display too.
 */
export function reportError(context: string, error: unknown) {
  const entry = recordError(context, error);

  toast.error(
    (t) => (
      <span
        className="block cursor-pointer font-mono"
        onClick={async () => {
          const ok = await copyText(formatEntry(entry));
          toast.dismiss(t.id);
          // Deliberately a toast rather than silence: a copy that quietly failed is worse than none,
          // because the user walks away believing they have the text.
          if (ok) toast.success('Error details copied');
          else toast.error('Could not copy — see Settings → RECENT ERRORS');
        }}
      >
        <span className="block text-sm">Could not {context}</span>
        <span className="block text-xs opacity-80">{entry.summary}</span>
        <span className="mt-1 block text-[11px] underline opacity-70">
          tap to copy details · also in Settings
        </span>
      </span>
    ),
    { duration: 8000 },
  );

  return entry;
}
