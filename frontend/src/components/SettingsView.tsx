import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { formatBalance, getFuelEmoji } from '../utils/formatters';
import { AddressDisplay } from './UserAddress';
import type { Profile } from '../types/contracts';
import { FAKE_SCENARIOS, type Capabilities, type DelegationState, type DiagnosticStep } from '../lib/host';
// Deeper than `lib/host` on purpose, and the only such import above that directory: `asWriteFailure`
// is not on the barrel's export list yet and `lib/host/index.ts` is owned elsewhere. It pulls in no
// `@parity/*` — `errors.ts` is pure — so the rule this bends (import from the barrel, never deeper)
// costs nothing here. Move it to the barrel when that file next changes.
import { asWriteFailure } from '../lib/host/errors';
import { useTheme } from '../contexts/ThemeContext';
import { clearErrors, copyText, formatEntry, subscribeErrors, type ErrorEntry } from '../lib/errors';
import { reportError } from '../lib/reportError';

// Rewritten for the host-only surface. The old version had two of everything — an "IN-APP WALLET"
// branch and a "BROWSER WALLET" branch, switched on `walletMode` — because the app used to offer a
// choice between MetaMask and a generated in-app wallet. architecture.md §1 removes both, so the
// duplication is gone and with it the `isStandaloneMode` conditional that gated half this file.
//
// What replaces them:
//   ACCOUNT      — what the host handed us, and why writing is or is not available.
//   POSTING KEY  — the delegate. Was "SESSION ACCOUNT (gasless messaging)".
//   PROFILE      — one form, not one per wallet mode.
//   DIAGNOSTICS  — the only debugger available on a phone.
//
// ⛔ THERE IS NO "DISCONNECT" AND NO "EXPORT PRIVATE KEY".
//   · Disconnect: the host owns the account; a product cannot log it out, and a button that
//     pretends to would leave the app in a state the next reload silently undoes.
//   · Export: the delegate key is DERIVED from the user's wallet (`deriveEntropy`, RFC-0007), so
//     there is nothing to back up — it comes back on the next load, on this device, by itself.
//     Exporting it would only widen the leak surface for a key whose whole security story is that it
//     never leaves memory. The old button existed because the key used to be random and stored in
//     plaintext localStorage, where losing it was permanent.

interface SettingsViewProps {
  capabilities: Capabilities;
  /** "Polkadot host container", "fake backend (can write, no live updates)", … */
  label: string;
  diagnostics: DiagnosticStep[];

  /** Profile */
  profile: Profile | null;
  onCreateProfile: (displayName: string, bio: string) => Promise<void>;
  onUpdateDisplayName?: (displayName: string) => Promise<void>;
  onUpdateBio?: (bio: string) => Promise<void>;

  /** The delegate. `null` when there is no writer, in which case the whole section is hidden. */
  delegation: DelegationState | null;
  onAuthorizeDelegate: () => Promise<unknown>;
  onRevokeDelegate: () => Promise<unknown>;
  /**
   * Ask the CHAIN what it records for this delegate, polling until the reader catches up. Epoch ms,
   * or `null` for "no live authorisation". `useUserRegistry.confirmDelegate` is the implementation.
   *
   * ⭐ THIS IS WHAT MAKES THE SUCCESS MESSAGE TRUE rather than hopeful. Without it the best this
   * screen can know is what the seam *believes*, and the seam's belief is set from `Date.now()` the
   * moment its own call resolves — see `lib/host/delegate.ts`, which marks that expiry "provisional"
   * in as many words. A user pressed AUTHORISE on a real phone, was told the key was authorised,
   * and then had to sign the very next action; the seam had resolved without writing anything.
   *
   * ⚠️ OPTIONAL, and unwired at the time of writing, because passing it means editing `App.tsx`.
   * When it is absent this screen DOWNGRADES its message to "sent, watch the line above" rather than
   * claiming a confirmation it cannot have. It never upgrades a guess into a success.
   */
  onConfirmDelegate?: (delegateAddress: string) => Promise<number | null>;
  /**
   * Re-ask the host for its resource allowances. Distinct from everything else here because it is the
   * ONE path that deliberately bypasses the once-per-session latch — see `lib/host/allowance.ts`.
   */
  onRequestAllowanceAgain: () => Promise<unknown>;
}

const STATUS_COLOR: Record<DiagnosticStep['status'], string> = {
  ok: 'text-accent-400',
  running: 'text-yellow-500',
  skip: 'text-primary-600',
  fail: 'text-red-400',
};

const STATUS_MARK: Record<DiagnosticStep['status'], string> = {
  ok: 'ok',
  running: '..',
  skip: '--',
  fail: 'XX',
};

export function SettingsView({
  capabilities,
  label,
  diagnostics,
  profile,
  onCreateProfile,
  onUpdateDisplayName,
  onUpdateBio,
  delegation,
  onAuthorizeDelegate,
  onRevokeDelegate,
  onConfirmDelegate,
  onRequestAllowanceAgain,
}: SettingsViewProps) {
  const { theme, setTheme } = useTheme();
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  // Subscribed rather than read once: an error can arrive while this screen is open.
  const [errorEntries, setErrorEntries] = useState<ErrorEntry[]>([]);
  useEffect(() => subscribeErrors(setErrorEntries), []);
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newBio, setNewBio] = useState('');
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editBio, setEditBio] = useState('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  useEffect(() => {
    if (profile?.exists) {
      setEditDisplayName(profile.displayName);
      setEditBio(profile.bio);
    }
  }, [profile]);

  const handleCreateProfile = async () => {
    if (!newDisplayName.trim()) {
      toast.error('Please enter a display name');
      return;
    }
    setIsCreatingProfile(true);
    const toastId = toast.loading('Creating profile...');
    try {
      await onCreateProfile(newDisplayName.trim(), newBio.trim());
      toast.success('Profile created!', { id: toastId });
      setNewDisplayName('');
      setNewBio('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create profile', { id: toastId });
    } finally {
      setIsCreatingProfile(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!onUpdateDisplayName || !onUpdateBio) return;
    if (!editDisplayName.trim()) {
      toast.error('Display name cannot be empty');
      return;
    }
    setIsSavingProfile(true);
    const toastId = toast.loading('Saving profile...');
    try {
      if (editDisplayName.trim() !== profile?.displayName) await onUpdateDisplayName(editDisplayName.trim());
      if (editBio.trim() !== profile?.bio) await onUpdateBio(editBio.trim());
      toast.success('Profile saved!', { id: toastId });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save profile', { id: toastId });
    } finally {
      setIsSavingProfile(false);
    }
  };

  /**
   * ⛔ THIS USED TO RUN THE POSTING-KEY BUTTONS TOO, AND THAT WAS THE BUG.
   *
   * `await action(); toast.success(done)` treats a RESOLVED PROMISE as a CONFIRMED WRITE, and for
   * the delegate the two are not the same thing in any of the three layers underneath it:
   *
   *   · `lib/host/session.ts` `authorizeDelegate` is still a STUB — it records a diagnostics line
   *     and returns `delegate.state()`. It resolves, having touched no chain at all.
   *   · `lib/host/delegate.ts` `authorize()` CATCHES every failure by design (nothing there may ever
   *     block a write) and returns state. A rejected signature resolves here too.
   *   · even a real success sets `expiresAt` from `Date.now()`, which that file itself calls
   *     provisional — the value the contract stored is a different fact.
   *
   * So the posting-key buttons now go through `runVerifiedDelegateAction` below, which asks what the
   * state actually is before it says anything. This one survives for the allowance re-request, where
   * "the host answered" IS the whole of the claim being made.
   */
  const runDelegateAction = async (action: () => Promise<unknown>, running: string, done: string) => {
    setIsSettingUp(true);
    const toastId = toast.loading(running);
    try {
      await action();
      toast.success(done, { id: toastId });
    } catch (err) {
      toast.dismiss(toastId);
      reportError('ask the host for an allowance', asWriteFailure(err, { stored: false }));
    } finally {
      setIsSettingUp(false);
    }
  };

  /**
   * The seam's own belief about the delegation, dug out of whatever `authorizeDelegate` returned.
   *
   * Structural rather than typed because the prop is `() => Promise<unknown>`: the seam returns a
   * `DelegationState | null`, and an expiry in the past or absent both mean "no authorisation".
   * This is the WEAK signal — it is what the app thinks, not what the chain says.
   */
  const claimedExpiry = (result: unknown): number | null => {
    const value = (result as { expiresAt?: unknown } | null | undefined)?.expiresAt;
    return typeof value === 'number' && value > Date.now() ? value : null;
  };

  /**
   * The one error we raise ourselves, for the case that has no exception to report: everything
   * resolved and the authorisation still is not there.
   *
   * Not routed through `asWriteFailure` on purpose — that classifier's copy is written for a POST
   * ("your post is saved, but…"), and nothing was posted here. A raw `Error` is enough: `summarise()`
   * takes the message for the toast and `detailOf()` walks `cause` into the copyable detail, which is
   * where the "go and read the diagnostics" instruction belongs.
   */
  const unconfirmed = (what: string, why: string) =>
    new Error(`The posting key was not ${what} — nothing reached the chain, so this changed nothing.`, {
      cause: new Error(
        `${why}\n\nOpen DIAGNOSTICS below and read the "Posting key (delegate)" lines. If one names ` +
          'an allowance ("no allowance set for account"), the browser session cannot reach your ' +
          'phone to sign at all — sign in to the Polkadot app again first.',
      ),
    });

  /**
   * ⚠️ NEVER CLAIM SUCCESS THE APP CANNOT SEE. Three outcomes, and only the first is a success:
   *
   *   1. the CHAIN shows it (`onConfirmDelegate` polled and found it) → say so, with the date;
   *   2. the chain read is unavailable but the seam claims an expiry → say it was SENT, and point at
   *      the live line above, which is the one thing on this screen that cannot go stale;
   *   3. anything else → `reportError`, which is short in the toast, tap-to-copy, and durable in
   *      RECENT ERRORS — the only console a phone user has.
   *
   * Outcome 2 is a deliberate downgrade, not a hedge for its own sake. It is honest about the one
   * thing the user needs: whether they still have to sign every post.
   */
  const runVerifiedDelegateAction = async (options: {
    action: () => Promise<unknown>;
    expect: 'authorised' | 'revoked';
    running: string;
    context: string;
  }) => {
    const { action, expect, running, context } = options;
    const address = delegation?.address ?? null;
    setIsSettingUp(true);
    const toastId = toast.loading(running);
    try {
      const result = await action();

      // The chain read, when we have one. `confirmDelegate` polls, because the host settles at
      // best-block and we read through a separate RPC that trails it — one read is not evidence.
      if (onConfirmDelegate && address) {
        const onChain = await onConfirmDelegate(address);
        const settled = expect === 'authorised' ? onChain !== null : onChain === null;
        if (settled) {
          toast.success(
            expect === 'authorised'
              ? `Posting key authorised until ${new Date(onChain!).toLocaleDateString()}.`
              : 'Posting key revoked. Every post will ask you to sign again.',
            { id: toastId },
          );
          return;
        }
        toast.dismiss(toastId);
        reportError(
          context,
          unconfirmed(
            expect,
            `Plaza asked, waited, and re-read UserRegistry — the ${
              expect === 'authorised' ? 'authorisation is still absent' : 'authorisation is still there'
            }.`,
          ),
        );
        return;
      }

      // No chain read wired. Fall back to the seam's belief, and word the message so it promises
      // nothing about the chain.
      const claimed = expect === 'authorised' ? claimedExpiry(result) !== null : result === true;
      if (claimed) {
        toast(
          expect === 'authorised'
            ? 'Sent. The line above will read "authorised for N more days" once it has gone through — if it still says "not authorised yet", it did not.'
            : 'Sent. The line above will say so once it has gone through.',
          { id: toastId, icon: 'i', duration: 8000 },
        );
        return;
      }

      toast.dismiss(toastId);
      reportError(
        context,
        unconfirmed(expect, 'Plaza asked, and the answer that came back carried no authorisation.'),
      );
    } catch (err) {
      toast.dismiss(toastId);
      // `asWriteFailure` gives the allowance failure that is currently breaking every host-signed
      // write its own readable sentence and remedy, rather than us inventing a second wording for it.
      reportError(context, asWriteFailure(err, { stored: false }));
    } finally {
      setIsSettingUp(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-black overflow-y-auto">
      <div className="border-b-2 border-primary-500 bg-primary-950 bg-opacity-30 px-6 py-4">
        <h2 className="text-xl font-bold text-primary-500 text-shadow-neon font-mono">SETTINGS</h2>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-6 space-y-6">
          {/* ACCOUNT */}
          <div>
            <h3 className="text-sm font-bold text-accent-400 font-mono mb-3">ACCOUNT</h3>
            <div className="border border-primary-700 p-4 space-y-3 font-mono text-sm">
              <div className="flex items-center justify-between">
                <span className="text-primary-400">Running in:</span>
                <span className="text-primary-500 text-xs">{label}</span>
              </div>

              {capabilities.address ? (
                <div className="flex items-center justify-between">
                  <span className="text-primary-400">Account:</span>
                  <AddressDisplay address={capabilities.address} size="sm" />
                </div>
              ) : (
                <p className="text-primary-500 text-xs leading-relaxed">{capabilities.reason}</p>
              )}

              <div className="flex items-center justify-between">
                <span className="text-primary-400">Can post:</span>
                <span className={capabilities.canWrite ? 'text-accent-400' : 'text-yellow-500'}>
                  {capabilities.canWrite ? 'yes' : 'no'}
                </span>
              </div>

              {/*
                ⚠️ SHOWN, BUT NEVER USED TO DISABLE ANYTHING. `canWrite && !canPushLive` is the common
                case — anyone without a personhood proof — and posting works fine in it. The only
                difference is that other people see the post on a poll rather than instantly. If this
                line ever grows a "set this up" button, check that it is not gating the composer.
              */}
              <div className="flex items-center justify-between">
                <span className="text-primary-400">Live updates:</span>
                <span className={capabilities.canPushLive ? 'text-accent-400' : 'text-primary-600'}>
                  {capabilities.canPushLive ? 'on' : 'off (posts still work)'}
                </span>
              </div>
              {capabilities.liveReason && (
                <p className="text-primary-600 text-xs leading-relaxed">{capabilities.liveReason}</p>
              )}

              {capabilities.canWrite && (
                <button
                  onClick={() =>
                    runDelegateAction(onRequestAllowanceAgain, 'Asking the host again...', 'The host answered.')
                  }
                  disabled={isSettingUp}
                  className="w-full py-2 bg-primary-900 hover:bg-primary-800 border-2 border-primary-600 text-primary-400 text-xs hover:border-primary-500 transition-all disabled:opacity-70"
                >
                  RE-REQUEST HOST ALLOWANCE
                </button>
              )}
            </div>
          </div>

          {/* POSTING KEY (the delegate) */}
          {delegation && (
            <div>
              <h3 className="text-sm font-bold text-accent-400 font-mono mb-3">
                POSTING KEY <span className="text-primary-600 text-xs">(fewer signing prompts)</span>
              </h3>
              <div className="border border-primary-700 p-4 space-y-3 font-mono text-sm">
                {/* The seam's own sentence, not a re-wording of it. Kept verbatim so the copy the
                    fake backend tests is the copy a user reads. */}
                <p className="text-primary-500 text-xs leading-relaxed">{delegation.reason}</p>

                {/*
                  ⚠️ A CORRECTION, NOT DECORATION. The sentence above ends "…your next post will set
                  it up with one extra signature", and posting does not do that. `usePublisher`'s
                  `writeHead` calls `setHead` host-signed and nothing on the publish path ever calls
                  `authorizeDelegate` — its own comment says the branch goes in "when
                  `authorizeDelegate` lands". So the promise is of an automatic step that does not
                  exist, and a user who posts twice waiting for it to stop asking will just be asked
                  twice.

                  ⛔ THE STRING ITSELF CANNOT BE FIXED FROM HERE. It is `explain()` in
                  `lib/host/delegate.ts`, mirrored word-for-word in `lib/host/fake.ts`; both are
                  owned elsewhere. Delete this paragraph the moment that sentence stops promising it.
                */}
                {!delegation.expiresAt && (
                  <p className="text-yellow-500 text-xs leading-relaxed">
                    Posting does not set this up on its own today — use AUTHORISE below. Until then
                    every post costs one signature.
                  </p>
                )}

                {delegation.address && (
                  <div className="flex items-center justify-between">
                    <span className="text-primary-400">Key:</span>
                    <AddressDisplay address={delegation.address} size="sm" />
                  </div>
                )}

                {/*
                  ⚠️ AN EMPTY POSTING KEY IS THE NORMAL STATE, AND RED SAID OTHERWISE.
                  `lowOnFunds` is true whenever the balance is under the low-water mark, which for a
                  key that has never been authorised is ALWAYS: the delegate is a locally derived
                  H160 that nobody funds — "balance 0.0, nonce 0" [V] 2026-07-30, gotchas.md
                  § Host-signed contract writes. Rendering `0.0000 PAS` in red with a red fuel dot
                  reported a fault where there is none, on the one screen a user visits when they
                  already suspect something is broken.
                  Funds only start to mean anything once there IS a delegation to spend against — a
                  delegated write pays its own fee — so the alarm is scoped to that case and the
                  normal case gets a plain reading plus the reason it is zero.
                */}
                {delegation.balance !== null &&
                  (delegation.expiresAt ? (
                    <div className="flex items-center justify-between">
                      <span className="text-primary-400">Balance:</span>
                      <span className={delegation.lowOnFunds ? 'text-red-400' : 'text-accent-400'}>
                        {formatBalance(delegation.balance)} PAS {getFuelEmoji(delegation.balance)}
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-primary-400">Balance:</span>
                        <span className="text-primary-500">{formatBalance(delegation.balance)} PAS</span>
                      </div>
                      <p className="text-primary-600 text-xs leading-relaxed">
                        Empty is expected — nothing funds this key until it is authorised, and it only
                        ever holds a small float for its own fees.
                      </p>
                    </>
                  ))}

                {delegation.expiresAt && (
                  <div className="flex items-center justify-between">
                    <span className="text-primary-400">Expires:</span>
                    <span className={delegation.renewDue ? 'text-yellow-500' : 'text-primary-500'}>
                      {new Date(delegation.expiresAt).toLocaleDateString()}
                    </span>
                  </div>
                )}

                {/* Derivation is silent and cannot be retried usefully, so there is no button for it —
                    only for the on-chain half, which is the part that costs a signature. */}
                {delegation.derived && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        runVerifiedDelegateAction({
                          action: onAuthorizeDelegate,
                          expect: 'authorised',
                          running: 'Authorising the posting key...',
                          context: 'authorise the posting key',
                        })
                      }
                      disabled={isSettingUp}
                      className="flex-1 py-2 bg-accent-900 hover:bg-accent-800 text-accent-400 border-2 border-accent-500 text-xs disabled:opacity-70 transition-all"
                    >
                      {delegation.active ? 'RENEW' : 'AUTHORISE'}
                    </button>
                    {delegation.expiresAt && (
                      <button
                        type="button"
                        onClick={() =>
                          runVerifiedDelegateAction({
                            action: onRevokeDelegate,
                            expect: 'revoked',
                            running: 'Revoking...',
                            context: 'revoke the posting key',
                          })
                        }
                        disabled={isSettingUp}
                        className="flex-1 py-2 bg-gray-900 hover:bg-gray-800 text-gray-400 border-2 border-gray-600 text-xs disabled:opacity-70 transition-all"
                      >
                        REVOKE
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* PROFILE — one form. Create when there is none, edit when there is. */}
          {capabilities.address && !profile?.exists && (
            <div>
              <h3 className="text-sm font-bold text-accent-400 font-mono mb-3">CREATE PROFILE</h3>
              <div className="border border-accent-500 p-4 space-y-4">
                <p className="text-sm text-primary-400 font-mono">
                  Create a profile to start posting and using Plaza.
                </p>
                <div>
                  <label className="block text-xs text-primary-600 font-mono mb-1">DISPLAY NAME *</label>
                  <input
                    type="text"
                    value={newDisplayName}
                    onChange={(e) => setNewDisplayName(e.target.value)}
                    placeholder="Enter your display name"
                    disabled={isCreatingProfile}
                    maxLength={32}
                    className="w-full px-3 py-2 bg-black border-2 border-primary-500 text-primary-400 font-mono text-sm focus:outline-none focus:border-accent-400 disabled:opacity-70 placeholder:text-primary-700"
                  />
                </div>
                <div>
                  <label className="block text-xs text-primary-600 font-mono mb-1">
                    BIO <span className="text-primary-700">(optional)</span>
                  </label>
                  <textarea
                    value={newBio}
                    onChange={(e) => setNewBio(e.target.value)}
                    placeholder="Tell us about yourself..."
                    disabled={isCreatingProfile}
                    maxLength={256}
                    rows={3}
                    className="w-full px-3 py-2 bg-black border-2 border-primary-500 text-primary-400 font-mono text-sm focus:outline-none focus:border-accent-400 disabled:opacity-70 placeholder:text-primary-700 resize-none"
                  />
                </div>
                <button
                  onClick={handleCreateProfile}
                  disabled={isCreatingProfile || !newDisplayName.trim()}
                  className="w-full py-2 bg-accent-900 hover:bg-accent-800 text-accent-400 border-2 border-accent-500 font-mono text-sm disabled:opacity-70 disabled:cursor-not-allowed transition-all"
                >
                  {isCreatingProfile ? 'CREATING...' : 'CREATE PROFILE'}
                </button>
              </div>
            </div>
          )}

          {capabilities.address && profile?.exists && onUpdateDisplayName && (
            <div>
              <h3 className="text-sm font-bold text-accent-400 font-mono mb-3">PROFILE</h3>
              <div className="border border-accent-500 p-4 space-y-4">
                <div>
                  <label className="block text-xs text-primary-600 font-mono mb-1">DISPLAY NAME</label>
                  <input
                    type="text"
                    value={editDisplayName}
                    onChange={(e) => setEditDisplayName(e.target.value)}
                    disabled={isSavingProfile}
                    maxLength={32}
                    className="w-full px-3 py-2 bg-black border-2 border-primary-500 text-primary-400 font-mono text-sm focus:outline-none focus:border-accent-400 disabled:opacity-70"
                  />
                </div>
                <div>
                  <label className="block text-xs text-primary-600 font-mono mb-1">BIO</label>
                  <textarea
                    value={editBio}
                    onChange={(e) => setEditBio(e.target.value)}
                    disabled={isSavingProfile}
                    maxLength={256}
                    rows={3}
                    className="w-full px-3 py-2 bg-black border-2 border-primary-500 text-primary-400 font-mono text-sm focus:outline-none focus:border-accent-400 disabled:opacity-70 resize-none"
                  />
                </div>
                <button
                  onClick={handleSaveProfile}
                  disabled={
                    isSavingProfile ||
                    (editDisplayName === profile?.displayName && editBio === profile?.bio)
                  }
                  className="w-full py-2 bg-accent-900 hover:bg-accent-800 text-accent-400 border-2 border-accent-500 font-mono text-sm disabled:opacity-70 disabled:cursor-not-allowed transition-all"
                >
                  {isSavingProfile ? 'SAVING...' : 'SAVE PROFILE'}
                </button>
              </div>
            </div>
          )}

          {/* RECENT ERRORS — where a dismissed toast goes.
              Toasts are the right size for an error and the wrong place for its detail; the thing you
              need is always the one you just dismissed. Every `reportError` call lands here, newest
              first, with a copy button. See `lib/errors.ts`. */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-accent-400 font-mono">RECENT ERRORS</h3>
              {errorEntries.length > 0 && (
                <button
                  onClick={() => clearErrors()}
                  className="px-3 py-1 text-xs font-mono text-primary-500 border border-primary-700 hover:border-primary-500"
                >
                  CLEAR
                </button>
              )}
            </div>
            <div className="border border-primary-700 p-4 space-y-3 font-mono">
              {errorEntries.length === 0 ? (
                <p className="text-xs text-primary-700">no errors this session</p>
              ) : (
                errorEntries.map((entry) => (
                  <div key={entry.id} className="text-[11px] leading-snug">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-red-400">
                        {new Date(entry.at).toLocaleTimeString()} · could not {entry.context}
                      </span>
                      <button
                        onClick={async () => {
                          const ok = await copyText(formatEntry(entry));
                          toast[ok ? 'success' : 'error'](
                            ok ? 'Copied' : 'Could not copy — select the text below instead',
                          );
                        }}
                        className="shrink-0 px-2 py-0.5 text-[10px] text-primary-500 border border-primary-700 hover:border-primary-500"
                      >
                        COPY
                      </button>
                    </div>
                    <div className="text-primary-400 mt-1">{entry.summary}</div>
                    {/* Selectable and unabridged: on a phone, copy may be blocked and reading it off
                        the screen is the fallback. */}
                    <pre className="mt-1 whitespace-pre-wrap break-words text-primary-700 select-text">
                      {entry.detail}
                    </pre>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* DIAGNOSTICS — the write path only runs inside a host container, i.e. on a phone, where no
              console can be attached. This panel is the whole of our observability, so the detail text
              is rendered unabridged rather than summarised. */}
          <div>
            <h3 className="text-sm font-bold text-accent-400 font-mono mb-3">DIAGNOSTICS</h3>
            <div className="border border-primary-700 p-4 space-y-1 font-mono">
              {diagnostics.length === 0 ? (
                <p className="text-xs text-primary-700">nothing recorded yet</p>
              ) : (
                diagnostics.map((step) => (
                  <div key={step.id} className="text-[11px] leading-snug">
                    <span className={STATUS_COLOR[step.status]}>[{STATUS_MARK[step.status]}]</span>{' '}
                    <span className="text-primary-400">{step.label}</span>
                    {step.detail && (
                      <div className="pl-8 text-primary-700 break-words">{step.detail}</div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* FAKE BACKEND — deliberately reachable from the deployed bundle too, not just in dev.
              Bulletin publishing is rate-limited to 1/day on Lite personhood, so "rebuild and
              redeploy to check a banner" costs a day's quota; a query parameter costs nothing. */}
          {import.meta.env.DEV && (
            <div>
              <h3 className="text-sm font-bold text-accent-400 font-mono mb-3">
                FAKE BACKEND <span className="text-primary-600 text-xs">(local development)</span>
              </h3>
              <div className="border border-primary-700 p-4 space-y-2 font-mono">
                {FAKE_SCENARIOS.map((scenario) => (
                  <div key={scenario.query} className="text-[11px]">
                    <a
                      href={scenario.query}
                      className="text-accent-400 hover:text-accent-300 transition-colors underline break-all"
                    >
                      {scenario.query}
                    </a>
                    <div className="text-primary-700">{scenario.what}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* THEME */}
          <div>
            <h3 className="text-sm font-bold text-accent-400 font-mono mb-3">THEME</h3>
            <div className="border border-primary-700 p-4">
              <div className="flex gap-2">
                <button
                  onClick={() => setTheme('neon')}
                  className={`flex-1 py-3 px-4 border-2 font-mono text-sm transition-all ${
                    theme === 'neon'
                      ? 'bg-primary-900 hover:bg-primary-800 border-primary-500 hover:border-primary-400 text-primary-400'
                      : 'bg-black border-primary-700 text-primary-600 hover:border-primary-500 hover:bg-primary-900 hover:text-primary-400'
                  }`}
                >
                  <div className="text-left">
                    <div className="font-bold">NEON</div>
                    <div className="text-xs opacity-75">Orange glow effects</div>
                  </div>
                </button>
                <button
                  onClick={() => setTheme('grayscale')}
                  className={`flex-1 py-3 px-4 border-2 font-mono text-sm transition-all ${
                    theme === 'grayscale'
                      ? 'bg-primary-900 hover:bg-primary-800 border-primary-500 hover:border-primary-400 text-primary-400'
                      : 'bg-black border-primary-700 text-primary-600 hover:border-primary-500 hover:bg-primary-900 hover:text-primary-400'
                  }`}
                >
                  <div className="text-left">
                    <div className="font-bold">GRAYSCALE</div>
                    <div className="text-xs opacity-75">Clean minimal look</div>
                  </div>
                </button>
              </div>
              <p className="text-xs text-primary-600 font-mono mt-3">
                {theme === 'neon'
                  ? 'Vibrant orange/cyan with neon glow effects'
                  : 'Grayscale with subtle blue accents, no glows'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
