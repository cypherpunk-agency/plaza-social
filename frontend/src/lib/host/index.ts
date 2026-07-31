// The host-container integration layer — public surface.
//
// EVERYTHING above this directory imports from here and nowhere deeper. In particular, nothing
// outside `lib/host/` may import `@parity/*`: those imports live in `sdk.ts` alone so they stay in
// their own lazily-loaded chunk, so a reader never downloads the signing SDK, and so a resolution
// failure cannot take the read path down.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE SEAM, IN ONE SCREEN
//
//   openBackend({ appName })            → HostBackend      real host, or the fake if ?backend=fake
//   backend.capabilities()              → { canRead, canWrite, canPushLive, address, reason }
//   backend.onCapabilities(cb)          → unsubscribe
//   backend.chainReader()               → ChainReader | null   anonymous, SDK-only, host-only
//   backend.signer()                    → { host: {...} }      ONE arm; the delegate arm is gone
//   backend.delegation() / .onDelegation(cb) / .authorizeDelegate() / .revokeDelegate()
//   backend.putBlob(bytes, { contentType })  → cid          ⭐ also the lazy-allowance trigger
//   backend.ensureAllowance()           → never call from a read path
//   backend.requestAllowanceAgain()     → the user-driven retry, bypasses the latch
//   backend.diagnostics                 → the only debugger available on a phone
//   backend.destroy()
//
// React binding: `hooks/useHostSession.ts`.
//
// THE FOUR RULES THIS SEAM EXISTS TO ENFORCE
//
//   1. `canWrite` and `canPushLive` are SEPARATE. `canWrite && !canPushLive` is the common case.
//      NEVER gate the composer on `canPushLive`.               (types.ts, capabilities.ts)
//   2. The allowance is requested at the first WRITE, never on load and never on a read path.
//      The latch caches the ATTEMPT, not the answer, and persists across reloads. (allowance.ts)
//   3. `AutoSigning` is never requested. It does nothing in this host and it was the sole reason the
//      latch could not be persisted.                            (allowance.ts, PLAZA_RESOURCES)
//   4. The delegate key is DERIVED (`deriveEntropy`, RFC-0007), never randomly generated and never
//      written to disk — and it does NOT sign. See `delegate.ts`.               (delegate.ts)
//   5. ⛔ THE SDK IS THE ONLY PATH, FOR READS AS WELL AS WRITES. No ethers provider, no HTTP RPC, no
//      gateway, no "fallback in case the SDK is unavailable". An unavailable SDK capability is an
//      error to SURFACE.                              (contracts.ts, utils/contracts.ts, bulletin.ts)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export { openBackend, parseBackendSelection, FAKE_SCENARIOS } from './backend'
export type { BackendSelection, OpenBackendOptions } from './backend'

export { createFakeBackend, FAKE_SELF_H160, FAKE_SELF_SS58 } from './fake'
export type { FakeCapabilityPreset, FakeDelegatePreset, FakeOptions } from './fake'

export { openHostSession } from './session'
export type { HostSessionOptions } from './session'

export { createCapabilityStore, READ_ONLY } from './capabilities'
export type { CapabilityStore } from './capabilities'

export { createDiagnostics, nullDiagnostics, STEP_LABELS } from './diagnostics'
export { insideContainer, productIdentifier, PRODUCT_NAMESPACE } from './container'
export { ALLOWANCE_FACTS } from './allowance'
export { DELEGATE_FACTS } from './delegate'

export {
  classifyWriteFailure,
  explainWriteFailure,
  plainWriteFailure,
} from './errors'
export type { WriteClassification, WriteExplanation, WriteFailureCode } from './errors'

export { describe, describeAge } from './util'

export { createSdkChainReader } from './contracts'

export type {
  AbiEntry,
  AllocationOutcome,
  Capabilities,
  ChainReader,
  DelegationState,
  Diagnostics,
  DiagnosticStatus,
  DiagnosticStep,
  HostAccount,
  HostBackend,
  PutBlobOptions,
  SignerSeam,
} from './types'
