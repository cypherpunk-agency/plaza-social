// The React binding for the host seam. The ONLY hook that knows a backend exists.
//
// It replaces `useWallet` (MetaMask) and `useAppWallet` (standalone in-app wallet), both deleted:
// architecture.md §1 decides the host container is the only surface, so there is no browser-wallet
// path and no in-app wallet mode to choose between any more.
//
// ⚠️ IT OPENS EXACTLY ONE BACKEND PER MOUNT AND NEVER RE-OPENS ON RENDER. Session setup talks to the
// host; doing it twice would double every permission round trip and, on a first visit, show the user
// two of every modal. The effect has an empty dependency list on purpose and `appName` is captured in
// a ref rather than depended on.
//
// ⚠️ `capabilities` IS THE ONLY THING COMPONENTS SHOULD BRANCH ON. Not `backend.kind`, not
// `delegation.active`, not the diagnostics. A component that special-cases the fake backend stops
// testing the real one.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ethers } from 'ethers'

import {
  openBackend,
  READ_ONLY,
  type Capabilities,
  type DelegationState,
  type DiagnosticStep,
  type HostBackend,
  type SignerSeam,
} from '../lib/host'

export interface HostSession {
  /** Still opening. Reads may already work; writes definitely do not yet. */
  isInitializing: boolean
  /** Short label for the diagnostics/settings screen: "Polkadot host container", "fake backend …". */
  label: string
  capabilities: Capabilities
  delegation: DelegationState | null
  diagnostics: DiagnosticStep[]

  /**
   * Anonymous read provider. `null` only if constructing it threw.
   *
   * ⚠️ This is what every feature hook should take for READS. It needs no wallet, no container and no
   * permission, which is why the app can render a full timeline for a visitor who has nothing.
   */
  provider: ethers.Provider | null

  /**
   * The two-arm signer seam. See `lib/host/types.ts`.
   *
   * `signer.delegateSigner` is an ordinary `ethers.Signer` and is what the existing feature hooks
   * consume today. `signer.host` is the prompting arm and is NOT an ethers signer — it cannot be,
   * because the host signs native Revive extrinsics rather than Ethereum transactions.
   */
  signer: SignerSeam

  /** Convenience aliases so call sites stay readable. */
  address: string | null
  canRead: boolean
  canWrite: boolean
  /** ⛔ NEVER use this to disable a composer. See `lib/host/types.ts`. */
  canPushLive: boolean

  authorizeDelegate: () => Promise<DelegationState | null>
  revokeDelegate: () => Promise<boolean>
  /** The user-driven allowance retry. Bypasses the once-per-session latch, deliberately. */
  requestAllowanceAgain: () => Promise<unknown>
  /** Escape hatch for the data layer: `putBlob`, `ensureAllowance`, `kind`. `null` until open. */
  backend: HostBackend | null
}

const EMPTY_SEAM: SignerSeam = {
  host: { account: null, signer: null, submit: null },
  delegateSigner: null,
}

export function useHostSession(appName: string): HostSession {
  const appNameRef = useRef(appName)
  const backendRef = useRef<HostBackend | null>(null)

  const [backend, setBackend] = useState<HostBackend | null>(null)
  const [isInitializing, setIsInitializing] = useState(true)
  const [capabilities, setCapabilities] = useState<Capabilities>(READ_ONLY)
  const [delegation, setDelegation] = useState<DelegationState | null>(null)
  const [diagnostics, setDiagnostics] = useState<DiagnosticStep[]>([])
  // Bumped whenever the delegate key or the host signer might have changed, so `signer` below is
  // recomputed. The seam is read through a function rather than held as state because the delegate
  // signer must be re-connected to the provider each time it is handed out.
  const [seamVersion, setSeamVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    const unsubscribers: Array<() => void> = []

    // `openBackend` never throws — it returns a read-only backend with a `reason` instead. The catch
    // is here only for the impossible case, and it still has to leave the app usable.
    openBackend({ appName: appNameRef.current })
      .then((opened) => {
        if (cancelled) {
          opened.destroy()
          return
        }
        backendRef.current = opened
        setBackend(opened)
        setCapabilities(opened.capabilities())
        setDelegation(opened.delegation())
        setDiagnostics(opened.diagnostics.list())
        setIsInitializing(false)

        unsubscribers.push(
          opened.onCapabilities((next) => {
            setCapabilities(next)
            setSeamVersion((v) => v + 1)
          }),
          opened.onDelegation((next) => {
            setDelegation(next)
            setSeamVersion((v) => v + 1)
          }),
          opened.diagnostics.subscribe(setDiagnostics),
        )
      })
      .catch(() => {
        if (!cancelled) setIsInitializing(false)
      })

    return () => {
      cancelled = true
      for (const off of unsubscribers) off()
      backendRef.current?.destroy()
      backendRef.current = null
    }
    // Once per mount. See the header — re-opening would double every host round trip and, on a first
    // visit, show the user two of every modal. `appName` is read from a ref precisely so that it
    // cannot become a dependency and cannot trigger a re-open.
  }, [])

  // The provider is built once, when the backend opens, so `backend` is the only dependency.
  const provider = useMemo(() => backend?.readProvider() ?? null, [backend])

  const signer = useMemo(
    () => backend?.signer() ?? EMPTY_SEAM,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backend, seamVersion],
  )

  const authorizeDelegate = useCallback(
    () => backendRef.current?.authorizeDelegate() ?? Promise.resolve(null),
    [],
  )
  const revokeDelegate = useCallback(
    () => backendRef.current?.revokeDelegate() ?? Promise.resolve(false),
    [],
  )
  const requestAllowanceAgain = useCallback(
    () => backendRef.current?.requestAllowanceAgain() ?? Promise.resolve(null),
    [],
  )

  return {
    isInitializing,
    label: backend?.label ?? 'connecting',
    capabilities,
    delegation,
    diagnostics,
    provider,
    signer,
    address: capabilities.address,
    canRead: capabilities.canRead,
    canWrite: capabilities.canWrite,
    canPushLive: capabilities.canPushLive,
    authorizeDelegate,
    revokeDelegate,
    requestAllowanceAgain,
    backend,
  }
}
