// The session diagnostics record, made reachable from the leaves that render a CONNECTING state.
//
// ⭐ WHY A CONTEXT AND NOT A PROP. The consumer is `components/BootConsole.tsx`, which renders inside
// `CollectionStatus` — a leaf that six views call and that takes no session props at all. Threading
// `diagnostics` to it would mean adding a pure pass-through prop to `ForumView`, `FeedView`,
// `ProfileView`, `UserPostsFeed`, `ReplyThread` *and* `CollectionStatus`, six components that would
// never read it, purely to move one session-wide array. That is the same situation `usePayments`
// documents, and it gets the same answer.
//
// ⛔ DO NOT CALL `useHostSession()` FROM A LEAF COMPONENT INSTEAD. That hook opens a backend per
// mount — a status line would open a second container session and double every permission round
// trip. There is exactly one backend; `App.tsx` owns it and this is how the tree borrows its record.
//
// This provider holds NOTHING of its own: `App.tsx` passes `host.diagnostics`, the array
// `useHostSession` already keeps in state and already hands to `SettingsView`. One source, two
// readers, no second telemetry mechanism.

import { createContext, useContext, type ReactNode } from 'react'

import type { DiagnosticStep } from '../lib/host'

/**
 * A stable module-level empty array. A fresh `[]` as the default would be a new identity on every
 * render of any consumer that reads the context without a provider above it, which is exactly the
 * kind of thing that turns a dependency array into a render loop.
 */
const NO_STEPS: DiagnosticStep[] = []

const DiagnosticsContext = createContext<DiagnosticStep[]>(NO_STEPS)

export function DiagnosticsProvider({
  steps,
  children,
}: {
  steps: DiagnosticStep[]
  children: ReactNode
}) {
  return <DiagnosticsContext.Provider value={steps}>{children}</DiagnosticsContext.Provider>
}

/**
 * What session setup has recorded so far, in execution order.
 *
 * ⚠️ AN EMPTY ARRAY IS NOT "NOTHING HAPPENED" — it is the normal state until the host handshake
 * resolves. See the header of `BootConsole.tsx`: `createDiagnostics()` lives inside
 * `openHostSession`, so no step is readable from React until that promise settles.
 */
export function useDiagnosticSteps(): DiagnosticStep[] {
  return useContext(DiagnosticsContext)
}
