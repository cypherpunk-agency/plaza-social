// What replaces `AccountButton`'s "CONNECT" button.
//
// ⛔ THERE IS NOTHING TO CONNECT, SO THERE IS NO CONNECT BUTTON.
//
// "Connect" belongs to a world where the user picks a wallet and grants a site access to it. That
// world is gone: architecture.md §1 makes the Polkadot host container the only surface, and the host
// either derives a product account and hands it over or it does not. Nothing the app does changes the
// answer, so a button implying the user could "connect" promises an action that does not exist.
//
// ⭐ THIS COMPONENT SHOWS AN ERROR, AND ONLY AN ERROR.
//
// The states behind `!canWrite` are not variations of one thing, and an earlier version made exactly
// that mistake — it labelled all of them "READ-ONLY", then "POSTING OFF", neither of which is true in
// every case. There are only two situations worth a header control:
//
//   · Inside the Polkadot app, signed in, and a step failed. The user is in the right place, their
//     account is fine, and they cannot fix it. That IS an error and it gets said so.
//   · Everything else — including an ordinary browser tab, where reading is the whole intended
//     experience and nothing is wrong. **Renders nothing.** A status chip there would label a normal
//     situation as a deficiency. The composer carries the explanation instead: tapping it opens the
//     same panel (`MessageInput`'s `onExplainDisabled`).
//
// ⚠️ Branch on CAPABILITIES, never on `address != null`. `canRead` and `canWrite` are independent, and
// an address can be present while writing is unavailable.

interface SessionStatusProps {
  /** True while the host session is still being established. NOT "connecting". */
  isInitializing: boolean;
  canRead: boolean;
  canWrite: boolean;
  /** Inside the Polkadot host container. Decides what `!canWrite` MEANS — see above. */
  insideHost: boolean;
  /** Opens the HostNotice panel: the reason, plus per-step diagnostics. */
  onExplain: () => void;
}

export function SessionStatus({
  isInitializing,
  canRead,
  canWrite,
  insideHost,
  onExplain,
}: SessionStatusProps) {
  // Working. The quiet, good case.
  if (canWrite) return null;

  // ⚠️ NEVER FLASH AN ERROR WHILE THE SESSION IS STILL COMING UP. Startup takes seconds on a phone,
  // and `canWrite` is false for all of them — rendering the error state here would show "! ERROR" to
  // every user on every load, then clear it. Silence until we actually know.
  if (isInitializing) return null;

  // An error is worth surfacing in the header in exactly two cases: signed into the host with
  // something broken, or reads failing too (which means the app is not working at all).
  const isError = insideHost || !canRead;
  if (!isError) return null;

  return (
    <button
      onClick={onExplain}
      title={
        insideHost
          ? 'Posting is unavailable — tap to see which step failed.'
          : 'Plaza could not reach the chain — tap for details.'
      }
      className="bg-primary-900 hover:bg-primary-800 text-primary-400 font-mono text-sm py-2 px-6 border-2 border-red-500 hover:border-red-400 transition-all duration-200 border-shadow-neon"
    >
      <span className="flex items-center gap-2">
        {/* Matches the [XX] marker DIAGNOSTICS already uses for a failed step. */}
        <span className="text-red-500">!</span>
        ERROR
      </span>
    </button>
  );
}
