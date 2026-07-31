// What replaces `WalletChoiceModal`.
//
// There is no longer a choice to offer. architecture.md §1 decides the host container is the ONLY
// surface: no MetaMask path, no standalone in-app wallet. So the old modal's question ("which wallet?")
// has no answer, and the honest replacement is an explanation of why writing is unavailable plus the
// one thing the user can actually do about it.
//
// ⚠️ IT NEVER SAYS "CONNECT YOUR WALLET". Inside the host there is nothing to connect — the host
// derives the product account and hands it over, or it does not. Outside the host there is no wallet
// this app can talk to at all. A button that cannot work is worse than a sentence that explains.

import { FAKE_SCENARIOS, type Capabilities, type DiagnosticStep } from '../lib/host'
import { BootConsole } from './BootConsole'

interface HostNoticeProps {
  isOpen: boolean
  onClose: () => void
  capabilities: Capabilities
  /** "Polkadot host container", "fake backend (read-only)", … */
  label: string
  diagnostics: DiagnosticStep[]
  /** Show the fake-backend scenario links. On by default in dev; harmless in production. */
  showScenarios?: boolean
}

// ⚠️ The status colour/mark tables and the row markup moved to `BootConsole.tsx`. This was the THIRD
// verbatim copy of them (here, `SettingsView`, and the connecting screen), and the copy on the
// connecting screen is the one nobody can open a console against.

export function HostNotice({
  isOpen,
  onClose,
  capabilities,
  label,
  diagnostics,
  showScenarios = import.meta.env.DEV,
}: HostNoticeProps) {
  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black bg-opacity-80" onClick={onClose} />

      <div className="relative w-full max-w-lg max-h-[85vh] overflow-y-auto border-2 border-primary-500 bg-black p-6 font-mono">
        {/* ⚠️ "POSTING NEEDS THE POLKADOT APP" is only true from OUTSIDE it. Shown inside the app it
            reads as nonsense — which is what a real user saw with every step green except the Bulletin
            chain. Inside the host, `canWrite === false` means something broke, not that the user is in
            the wrong place. */}
        <h2 className="text-lg font-bold text-primary-500 text-shadow-neon mb-1">
          {capabilities.canWrite
            ? 'POSTING IS AVAILABLE'
            : capabilities.insideHost
              ? 'POSTING IS UNAVAILABLE'
              : 'POSTING NEEDS THE POLKADOT APP'}
        </h2>
        <p className="text-xs text-primary-700 mb-4">{label}</p>

        {/* The reason, verbatim from the capability model. Not re-worded here, so that the sentence a
            user reads is the same sentence the seam decided on. */}
        {capabilities.reason && (
          <p className="text-sm text-primary-400 mb-4 leading-relaxed">{capabilities.reason}</p>
        )}

        {/* ⚠️ Shown as INFORMATION, never as a blocker. `canWrite && !canPushLive` is the common case
            for anyone without a personhood proof, and posting works fine in it. */}
        {capabilities.canWrite && capabilities.liveReason && (
          <p className="text-sm text-yellow-500 mb-4 leading-relaxed">{capabilities.liveReason}</p>
        )}

        {/* ⚠️ THE SECOND BULLET USED TO BE UNCONDITIONAL and told users already inside the Polkadot app
            to go and open Plaza inside the Polkadot app. Advice for "you are in the wrong place" is
            actively misleading when the truth is "you are in the right place and something failed", so
            it is now gated on `insideHost`. Nothing here restates `reason` — that sentence is written
            once, by the seam, and rendered above. */}
        {!capabilities.canWrite && (
          <ul className="text-sm text-primary-500 space-y-2 mb-5 list-none">
            <li>· Reading works here and needs nothing at all.</li>
            {capabilities.insideHost ? (
              <li>· Nothing is wrong with your account — see DIAGNOSTICS below for what failed.</li>
            ) : (
              <li>· To post, open Plaza from inside the Polkadot app on your phone.</li>
            )}
          </ul>
        )}

        <details className="mb-4">
          <summary className="text-xs text-accent-400 hover:text-accent-300 transition-colors cursor-pointer">DIAGNOSTICS</summary>
          {/* The only debugger available on a phone. Rendered raw, in execution order, with the
              detail text unabridged — a summarised failure is a failure nobody can act on. */}
          <div className="mt-2 border border-primary-800 p-3">
            {/* Steps passed as a PROP: this modal already receives the array and must not acquire a
                dependency on `DiagnosticsProvider` being above it. */}
            <BootConsole steps={diagnostics} variant="panel" />
          </div>
        </details>

        {showScenarios && (
          <details className="mb-4">
            <summary className="text-xs text-accent-400 hover:text-accent-300 transition-colors cursor-pointer">
              FAKE BACKEND (local development)
            </summary>
            <div className="mt-2 border border-primary-800 p-3 space-y-2">
              <p className="text-[11px] text-primary-600">
                The SDK throws outside a container, so these are the only way to exercise the write UI
                on a development machine.
              </p>
              {FAKE_SCENARIOS.map((scenario) => (
                <div key={scenario.query} className="text-[11px]">
                  <a
                    href={scenario.query}
                    className="text-accent-400 underline break-all"
                  >
                    {scenario.query}
                  </a>
                  <div className="text-primary-700">{scenario.what}</div>
                </div>
              ))}
            </div>
          </details>
        )}

        <button
          onClick={onClose}
          className="w-full py-2 bg-primary-900 hover:bg-primary-800 text-primary-400 border-2 border-primary-500 hover:border-primary-400 text-sm transition-all"
        >
          CLOSE
        </button>
      </div>
    </div>
  )
}
