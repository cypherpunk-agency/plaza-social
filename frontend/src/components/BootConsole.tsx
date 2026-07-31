// The boot console: session establishment, rendered as a terminal log instead of the word
// CONNECTING.
//
// Two jobs, and the second is the one that justifies the code:
//
//   1. A slow start becomes legible. On a phone the container handshake, an 881 kB chain-metadata
//      chunk and the first reads all happen before anything renders, and the old screen said only
//      `CONNECTING...` for the whole of it.
//   2. ⭐ PRODUCTION DEBUGGING ON A PHONE. There is no devtools inside the host container. When the
//      session does not come up, this puts the entire diagnostics record — the same record
//      `SettingsView` shows — on the screen the user is already stuck on, instead of behind a
//      navigation they cannot reach because nothing has loaded.
//
// ⛔ IT IS NON-INTERACTIVE VISUAL SUGAR, SO IT IS MUTED. Everything here is `primary-600`/`700`/`800`
//    — the dim end of the ramp — and it takes no tab stop and no pointer affordance. The ONE
//    exception is a failed step, which carries `text-red-400`: a failure is information the reader
//    needs, not decoration. Do not brighten the rest to match it.
//
// ⚠️ EVERY COLOUR CLASS HERE MUST BE A SHADE DECLARED IN THE `@theme static` BLOCK IN `index.css`.
//    A colour Tailwind has not been told about generates NO CSS AT ALL, silently — see
//    `frontend/CLAUDE.md` § Interaction states. `primary-600/700/800/900` and stock `red-400` are all
//    declared or stock; nothing new was invented for this file.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ⚠️⚠️ WHAT THIS CANNOT SHOW YET, AND WHY — read before "fixing" the empty first line.
//
// `createDiagnostics()` is created INSIDE `openHostSession` (`lib/host/session.ts`), and
// `useHostSession` can only call `.subscribe()` after `openBackend(...)` RESOLVES. Every step
// recorded during the handshake — container, sdk, connect, permChain, bulletin, chain — is therefore
// already in the past by the time React can read any of it. So on a session that comes up normally,
// `steps` is EMPTY for the whole connecting window and the console can honestly show only the
// elapsed clock and "waiting on the host handshake".
//
// Where it is fully live today:
//   · a session that does NOT come up — `chain` settles `fail`/`skip`, `provider` stays null, the
//     view stays `connecting` forever, and the whole record including the failure is on screen. This
//     is the case that used to show a permanent, contentless `CONNECTING...`.
//   · everything recorded after open — allowance, delegate, submit, headwrite, publish, and the
//     read/chain counters — which stream into the `panel` variant in Settings.
//
// ⛔ DO NOT CLOSE THE GAP BY INVENTING STEPS HERE. A hard-coded "expected" step list that ticks
// itself along would be a progress bar made of fiction, and this repo already has a rule about that
// (`publish.ts` `storeBlock = 0`: a fabricated number produces a confidently wrong readout, a
// missing one produces none). The fix is one line in `lib/host/`, which this component does not own:
// have `openHostSession` publish its `Diagnostics` object synchronously (or have `openBackend`
// resolve `{ diagnostics }` before the handshake) so `useHostSession` can subscribe from t=0.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'

import { useDiagnosticSteps } from '../hooks/useDiagnostics'
import type { DiagnosticStep } from '../lib/host'

/** Two characters wide in every case, so the labels line up in a monospace column. */
const MARK: Record<DiagnosticStep['status'], string> = {
  ok: 'ok',
  running: '..',
  skip: '--',
  fail: 'XX',
}

interface Tone {
  mark: string
  label: string
  detail: string
}

/**
 * The muted treatment. Measured against `#000` with the default orange theme:
 * `primary-600 #ea580c` ≈ 5.9:1, `primary-700 #c2410c` ≈ 4.1:1, `primary-800 #9a3412` ≈ 2.9:1.
 * The running step sits one notch brighter than the settled ones so the eye lands on what is
 * happening now; details sit one notch dimmer because they are reference text, not the line.
 */
const BOOT_TONE: Record<DiagnosticStep['status'], Tone> = {
  ok: { mark: 'text-primary-700', label: 'text-primary-700', detail: 'text-primary-800' },
  running: { mark: 'text-primary-600', label: 'text-primary-600', detail: 'text-primary-800' },
  skip: { mark: 'text-primary-800', label: 'text-primary-800', detail: 'text-primary-800' },
  // The exception. A failure is not sugar, and its detail is the payload someone will read off a
  // phone screen or copy out, so both halves stay legible.
  fail: { mark: 'text-red-400', label: 'text-red-400', detail: 'text-red-400' },
}

/**
 * The Settings treatment — unchanged from what `SettingsView` rendered inline before this component
 * existed. There the record is the panel's SUBJECT rather than background texture, so it is not
 * muted and must not be.
 */
const PANEL_TONE: Record<DiagnosticStep['status'], Tone> = {
  ok: { mark: 'text-accent-400', label: 'text-primary-400', detail: 'text-primary-700' },
  running: { mark: 'text-yellow-500', label: 'text-primary-400', detail: 'text-primary-700' },
  skip: { mark: 'text-primary-600', label: 'text-primary-400', detail: 'text-primary-700' },
  fail: { mark: 'text-red-400', label: 'text-primary-400', detail: 'text-primary-700' },
}

function StepLine({ step, tone }: { step: DiagnosticStep; tone: Record<DiagnosticStep['status'], Tone> }) {
  const t = tone[step.status]
  return (
    <div className="text-[11px] leading-snug min-w-0 wrap-anywhere">
      {/* `[ok]` reads as a marker in a log; a screen reader would otherwise announce the bracket
          soup as punctuation between two label fragments. */}
      <span className={t.mark}>
        <span aria-hidden="true">[{MARK[step.status]}]</span>
        <span className="sr-only">{step.status}:</span>
      </span>{' '}
      <span className={t.label}>{step.label}</span>
      {/* `break-words`: details carry addresses, CIDs and package names — unbreakable 40+ character
          runs that will push a 375px page into horizontal scroll without this. */}
      {/*
        `pl-8` = 32px ≈ 4.8 monospace characters at 11px, which is the width of `[ok] ` — so the
        detail hangs under the label rather than under the marker. Kept from the Settings panel this
        markup came from.

        ⚠️ `wrap-anywhere`, NOT `break-words`, AND THE DIFFERENCE IS MEASURABLE. `break-words` is
        `overflow-wrap: break-word`, which by spec does NOT reduce a box's MIN-CONTENT width — it
        only breaks a long token once the box is already too narrow. Details here carry SS58
        addresses (48 characters) and 0x keys (42), and on the connecting screen those sit inside a
        `flex-1` chain whose ancestors compute `min-width: auto`. Measured at 375×812 with
        `break-words`: the forum column was forced to **406.8px**, i.e. ~32px of the app pushed off a
        375px screen (clipped by an ancestor `overflow-hidden`, so `document.scrollWidth` still read
        375 and it did NOT look like a scroll bug). `overflow-wrap: anywhere` is the one that counts
        as a soft wrap opportunity for intrinsic sizing, and it takes the column back to 375.
        ⛔ Not `break-all`: that would hyphen-free-chop ordinary prose mid-word, and most of a detail
        line is a sentence.
      */}
      {step.detail && <div className={`pl-8 wrap-anywhere ${t.detail}`}>{step.detail}</div>}
    </div>
  )
}

export interface BootConsoleProps {
  /**
   * The record to render. Defaults to the session record from `DiagnosticsProvider`, which is what
   * the connecting state uses; `SettingsView` passes its own prop so it does not depend on the
   * provider being above it.
   */
  steps?: DiagnosticStep[]
  /**
   * `boot` — muted, framed, with a clock and a cursor. The connecting state.
   * `panel` — the plain unmuted list Settings has always shown. No clock, no cursor: it is not a
   * live boot, it is a record, and a blinking cursor there would imply something is still running.
   */
  variant?: 'boot' | 'panel'
}

export function BootConsole({ steps, variant = 'boot' }: BootConsoleProps) {
  const fromContext = useDiagnosticSteps()
  const record = steps ?? fromContext

  if (variant === 'panel') {
    return (
      <div className="font-mono space-y-1 min-w-0">
        {record.length === 0 ? (
          <p className="text-[11px] text-primary-700">nothing recorded yet</p>
        ) : (
          record.map((step) => <StepLine key={step.id} step={step} tone={PANEL_TONE} />)
        )}
      </div>
    )
  }

  return <BootLog record={record} />
}

/**
 * Split out so the clock's `useState`/`useEffect` never run for the `panel` variant — Settings is
 * open for minutes at a time and has no use for a 1 Hz tick.
 */
function BootLog({ record }: { record: DiagnosticStep[] }) {
  const elapsed = useElapsedSeconds()

  /**
   * ⭐ THE TERMINATION RULE, AND IT IS DERIVED FROM THE ONE STEP THAT ACTUALLY GATES THE SCREEN.
   *
   * `connecting` means `provider === null`, and `provider` is `backend.chainReader()`, which is
   * non-null iff `session.ts` recorded `chain` as `ok`. So:
   *
   *   · `chain: ok`      → the session is up, this component is unmounted by `CollectionStatus`.
   *   · `chain: fail`    → no chain reader will ever exist (outside the host, SDK missing, …).
   *   · `chain: skip`    → `?rpc=off`, chain reads deliberately switched off.
   *
   * The last two are settled states that would otherwise scroll a cursor forever, which is worse
   * than a spinner because it looks like progress. They print a halt line and the cursor stops.
   *
   * ⚠️ A `fail` on any OTHER step is NOT a halt. `bulletin` and `read` fail routinely on sessions
   * that go on to work; treating any failure as fatal would tell a working app it was broken.
   */
  const chain = record.find((step) => step.id === 'chain')
  const halted = !!chain && chain.status !== 'ok' && chain.status !== 'running'

  return (
    <div
      // A status region, not a widget: no tab stop, no interactive role, polite announcements only.
      role="status"
      aria-live="polite"
      className="w-full max-w-[70ch] mx-auto mt-3 text-left font-mono border border-primary-900 p-3 space-y-0.5 max-h-[50vh] overflow-y-auto min-w-0"
    >
      {/*
        The clock is measured BY THIS COMPONENT — `performance`-grade wall time since it mounted —
        and it is labelled `t+` rather than attributed to any step, because diagnostics records no
        timings and inventing per-step ones would be fiction. What it does answer is the actual
        question a slow start raises: how long have I been sitting here.
      */}
      <div className="text-[11px] leading-snug text-primary-800">
        <span aria-hidden="true">&gt; </span>plaza session &middot; t+{elapsed}s
      </div>

      {record.length === 0 && (
        // Honest, and it is the debugging fact: if this line sits alone for eight seconds, the host
        // handshake is where the time is going. See the header for why no steps are readable yet.
        <div className="text-[11px] leading-snug text-primary-700">
          waiting on the host handshake &mdash; no step has reported yet
        </div>
      )}

      {record.map((step) => (
        <StepLine key={step.id} step={step} tone={BOOT_TONE} />
      ))}

      {halted ? (
        <div className="text-[11px] leading-snug text-red-400">
          halted &mdash; no chain reader, so nothing on this screen will load. The line above says
          why.
        </div>
      ) : (
        <div className="text-[11px] leading-snug text-primary-700" aria-hidden="true">
          {/* One cheap opacity animation, and `motion-reduce:` turns it off. Nothing else moves. */}
          <span className="animate-pulse motion-reduce:animate-none">_</span>
        </div>
      )}
    </div>
  )
}

/**
 * Seconds since mount, ticking at 1 Hz.
 *
 * Deliberately the cheapest possible thing during the most contended moment of the app's life: one
 * interval, one integer of state, and it re-renders a handful of text nodes. It is NOT gated on
 * `prefers-reduced-motion` — a clock is information, not motion — but the cursor's blink is.
 */
function useElapsedSeconds(): number {
  const [startedAt] = useState(() => Date.now())
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(id)
  }, [startedAt])

  return elapsed
}
