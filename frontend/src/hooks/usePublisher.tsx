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
import { ethers } from 'ethers'

import PostRegistryABI from '../contracts/PostRegistry.json'
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

export interface PublisherProviderProps {
  postRegistryAddress: string | null
  provider: ethers.Provider | null
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

    const registry = new ethers.Contract(postRegistryAddress, PostRegistryABI.abi, provider)

    const readHead = async (registryId: string): Promise<HeadRow | null> => {
      const head = (await registry.headOf(registryId, author)) as OnChainHead
      if (!head?.cid) return null
      return {
        cid: head.cid,
        prev: head.prev || null,
        // ⚠️ NOT `head.at`. On ethers v6 a decoded struct is a `Result`, which subclasses Array, so
        // `.at` resolves to `Array.prototype.at` and hands back a FUNCTION. The contract names the
        // field `movedAt` for exactly this reason — see PostRegistry's `HeadRef` docstring.
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

  return <PublisherContext.Provider value={publisher}>{children}</PublisherContext.Provider>
}

/** The publisher, or null when this session cannot write. Never throws — read-only is not an error. */
export function usePublisher(): Publisher | null {
  return useContext(PublisherContext)
}
