// The publisher: chain plumbing, plus the React context that carries it.
//
// `lib/publish.ts` owns the sequencing and knows nothing about ethers or ABIs. This file is the
// other half — it turns `PostRegistry` into the three functions that module needs, and hands the
// result to the tree.
//
// ⚠️ CONTEXT RATHER THAN PROPS, DELIBERATELY. The composers that need it sit four and five levels
// down (`App → ProfileView → UserPostsFeed → NewPostForm`), and every component in between is pure
// presentation with no business knowing a Bulletin write path exists. Threading `putBlob` and
// `hostWrite` through them would put the write path in five signatures and make the next migration —
// chat, replies — touch all five again.
//
// `null` means this session cannot write. That is the honest read-only state and NOT an error:
// components branch on it to decide whether to offer a composer at all.

import { createContext, useContext, useMemo, type ReactNode } from 'react'

import PostRegistryABI from '../contracts/PostRegistry.json'
import { createReadContract, type Provider } from '../utils/contracts'
import {
  createPublisher,
  type HeadRow,
  type Publisher,
  type PutBlob,
  type WriteHeadArgs,
} from '../lib/publish'

/** See `lib/host/types.ts` — `HostBackend.writeContract`. */
export type HostWrite = (
  address: string,
  abi: Record<string, unknown>[],
  method: string,
  args: unknown[],
  label: string,
) => Promise<{ txHash: string }>

/** Matches PostRegistry's `HeadRef` tuple. */
interface OnChainHead {
  cid: string
  prev: string
  storeBlock: bigint
  movedAt: bigint
  by: string
  allowed: boolean
}

const PublisherContext = createContext<Publisher | null>(null)

/**
 * ⭐ THE HOST-SIGNED WRITE, AS CONTEXT. Added 2026-07-31 with the removal of the delegate arm.
 *
 * `useVoting`, `useFollowRegistry` and (for its non-owner calls) `useUserRegistry` are mounted by
 * presentation components — `ForumView`, `ReplyThread`, `UserPostsFeed`, `FeedView`, `ProfileView` —
 * which pass them a `signer` prop and nothing else. That `signer` was the delegate arm, which could
 * never work (see `lib/host/types.ts` `SignerSeam`), and the replacement is `writeContract`, which
 * lives on the backend rather than in a prop.
 *
 * ⚠️ CONTEXT RATHER THAN A NEW PROP, for the same reason `PublisherContext` is: threading it down
 * would put the write path in five more component signatures, all of them pure presentation with no
 * business knowing one exists — and would make the NEXT migration touch all five again.
 *
 * `null` means this session cannot write. That is the honest read-only state, not an error.
 */
const HostWriteContext = createContext<HostWrite | null>(null)

/** The host-signed contract writer, or `null` when this session cannot write. Never throws. */
export function useHostWrite(): HostWrite | null {
  return useContext(HostWriteContext)
}

export interface PublisherProviderProps {
  postRegistryAddress: string | null
  /** The SDK chain reader. See `utils/contracts.ts` — NOT an ethers provider. */
  provider: Provider | null
  /** The account content is credited to — the product account's H160. */
  author: string | null
  putBlob: PutBlob | null | undefined
  hostWrite: HostWrite | null | undefined
  children: ReactNode
}

export function PublisherProvider({
  postRegistryAddress,
  provider,
  author,
  putBlob,
  hostWrite,
  children,
}: PublisherProviderProps) {
  const publisher = useMemo(() => {
    if (!postRegistryAddress || !provider || !author || !putBlob || !hostWrite) return null

    // ⚠️ The SDK read path, not `new ethers.Contract(...)`. `headOf` is the read-after-write
    // confirmation loop's only source of truth, so it was one of the loudest external-HTTP callers
    // in the app. See `utils/contracts.ts`.
    const registry = createReadContract(postRegistryAddress, PostRegistryABI.abi, provider)
    if (!registry) return null

    const readHead = async (registryId: string): Promise<HeadRow | null> => {
      const head = (await registry.headOf(registryId, author)) as OnChainHead
      if (!head?.cid) return null
      return {
        cid: head.cid,
        prev: head.prev || null,
        // ⚠️ NOT `head.at`. `headOf` returns a STRUCT, and the contract names this field `movedAt`
        // rather than `at` for a decoder-specific reason worth keeping: on ethers v6 a decoded struct
        // is a `Result`, which subclasses Array, so `.at` resolved to `Array.prototype.at` and handed
        // back a FUNCTION. See PostRegistry's `HeadRef` docstring.
        at: head.movedAt > 0n ? Number(head.movedAt) * 1000 : null,
        by: head.by,
      }
    }

    /**
     * ⚠️ `setHead`, HOST-SIGNED — not `setHeadFor` via the delegate. The delegate is unauthorised and
     * unfunded today; sending from it produced `code 1012 "Transaction is temporarily banned"`. When
     * `authorizeDelegate` lands, the branch goes HERE — `setHeadFor(author, …)` signed by the
     * delegate when the delegation is active, this call otherwise. The head lands in the same row
     * either way: the contract credits the WRITER, never the signing key.
     */
    const writeHead = ({ registry: id, group, cid, prev, storeBlock }: WriteHeadArgs) =>
      hostWrite(
        postRegistryAddress,
        PostRegistryABI.abi as unknown as Record<string, unknown>[],
        'setHead',
        [id, group, cid, prev, storeBlock],
        'setHead',
      )

    return createPublisher({ author, readHead, putBlob, writeHead })
  }, [postRegistryAddress, provider, author, putBlob, hostWrite])

  return (
    <HostWriteContext.Provider value={hostWrite ?? null}>
      <PublisherContext.Provider value={publisher}>{children}</PublisherContext.Provider>
    </HostWriteContext.Provider>
  )
}

/** The publisher, or null when this session cannot write. Never throws — read-only is not an error. */
export function usePublisher(): Publisher | null {
  return useContext(PublisherContext)
}
