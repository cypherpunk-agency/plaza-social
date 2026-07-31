// Where errors go, so that "Failed to create thread" is never the end of the trail.
//
// ⭐ THE PROBLEM THIS SOLVES. A toast is the right SIZE for an error — it must not take the screen —
// but it is the wrong PLACE for the detail. `Failed to create thread` told a user nothing, and the
// actual cause (an ethers `CALL_EXCEPTION` naming a selector against the wrong contract) existed only
// in a console nobody can open on a phone.
//
// THE PARADIGM, in three parts:
//
//   1. **Short toast.** One sentence a person can act on, or at least recognise. Never a stack trace.
//   2. **Tap to copy.** The toast copies the FULL text — cause chain, contract, selector, everything.
//      A user who cannot read a stack trace can still paste one, which is what actually gets a bug
//      reported accurately.
//   3. **A durable log.** Every reported error lands here and the settings screen lists the recent
//      ones. Toasts vanish, and the thing you need is always the error you just dismissed.
//
// Deliberately NOT a modal: an error that blocks the screen makes the app feel broken and buries the
// state the user needs to see in order to understand it.

/** How many to keep. Enough to cover a session's worth of poking; small enough to stay readable. */
const MAX_ENTRIES = 25;

export interface ErrorEntry {
  id: number;
  at: number;
  /** What the user was doing — "create thread", not "handleSubmit". */
  context: string;
  /** The one-line version, shown in the toast and the list. */
  summary: string;
  /** Everything: nested causes, contract data, the original object stringified. */
  detail: string;
}

let nextId = 1;
const entries: ErrorEntry[] = [];
const listeners = new Set<(entries: ErrorEntry[]) => void>();

const emit = () => {
  const snapshot = [...entries];
  for (const listener of listeners) listener(snapshot);
};

export function recentErrors(): ErrorEntry[] {
  return [...entries];
}

export function subscribeErrors(listener: (entries: ErrorEntry[]) => void): () => void {
  listeners.add(listener);
  listener([...entries]);
  return () => listeners.delete(listener);
}

export function clearErrors(): void {
  entries.length = 0;
  emit();
}

/**
 * Pull a human-usable sentence out of whatever was thrown.
 *
 * Ethers wraps the useful part several layers down and puts an unreadable dump on `.message`, so the
 * order here matters: prefer the fields that name a CAUSE over the ones that describe a SYMPTOM.
 */
export function summarise(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return String(error);

  const e = error as Record<string, unknown>;

  // ⭐ FIRST, AHEAD OF EVERY ETHERS BRANCH. A `WriteFailure` (`lib/host/errors.ts`) has already been
  // interpreted by the one layer that knows which half of the two-signature write failed and whether
  // the body survived, so its `message` is the best sentence anyone will produce for this error.
  // Letting an ethers heuristic run first would replace it — `e.reason` on a wrapped host error is
  // whatever the SDK happened to put there, which is how the raw
  // "Submit failed, no allowance set for account" reached a user's screen in the first place.
  if (e.name === 'WriteFailure' && typeof e.message === 'string' && e.message) return e.message;

  // Ethers v6 puts the human part here and buries it in `.message`.
  const short = e.shortMessage;
  if (typeof short === 'string' && short) return short;

  // A revert reason the contract actually provided.
  const reason = e.reason;
  if (typeof reason === 'string' && reason && reason !== 'require(false)') return reason;

  // A `require(false)` with no data almost always means the function does not exist on the target —
  // which is a wiring bug, not a contract rejecting the user. Say so, because the raw text implies
  // the opposite.
  if (reason === 'require(false)' || e.code === 'CALL_EXCEPTION') {
    return 'The contract rejected this call, or does not have this function at that address.';
  }

  const message = e.message;
  if (typeof message === 'string' && message) return message.split('\n')[0].slice(0, 200);

  return 'Unknown error';
}

/** Everything worth pasting into a bug report. */
export function detailOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  let depth = 0;

  while (current && depth < 5) {
    const e = current as Record<string, unknown>;
    if (typeof e.message === 'string') parts.push(e.message);
    // `steps` / `stored` / `confidence` come from a `WriteFailure`. They belong in the COPYABLE
    // detail and never in the toast: the remedy is several lines long, and the durable log is where
    // someone re-reads it after the toast has gone. `cause` below then appends the raw host string,
    // so a bug report carries the readable version AND the original.
    for (const key of ['code', 'stored', 'confidence', 'reason', 'shortMessage', 'data', 'to', 'action', 'steps'] as const) {
      if (e[key] !== undefined) parts.push(`${key}: ${String(e[key])}`);
    }
    current = e.cause;
    depth += 1;
    if (current) parts.push('--- caused by ---');
  }

  if (parts.length === 0) {
    try {
      parts.push(JSON.stringify(error));
    } catch {
      parts.push(String(error));
    }
  }
  return parts.join('\n');
}

/**
 * Record an error. Returns the entry so a caller can show its summary.
 *
 * ⚠️ Never throws, whatever it is handed. A reporting path that can fail turns one visible error into
 * two invisible ones.
 */
export function recordError(context: string, error: unknown): ErrorEntry {
  const entry: ErrorEntry = {
    id: nextId++,
    at: Date.now(),
    context,
    summary: (() => {
      try {
        return summarise(error);
      } catch {
        return 'Unknown error';
      }
    })(),
    detail: (() => {
      try {
        return detailOf(error);
      } catch {
        return String(error);
      }
    })(),
  };

  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  // Still worth a console line where one exists — this supplements it, never replaces it.
  console.error(`[${context}]`, error);
  emit();
  return entry;
}

/** Best-effort clipboard write. Falsy result means "tell the user it did not copy". */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The full text of one entry, formatted for pasting. */
export function formatEntry(entry: ErrorEntry): string {
  return [
    `Plaza error — ${entry.context}`,
    new Date(entry.at).toISOString(),
    '',
    entry.summary,
    '',
    entry.detail,
  ].join('\n');
}
