import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { Reply } from "../types/contracts";
import PostRegistryABI from "../contracts/PostRegistry.json";
import { createReadContract, type Provider, type Signer } from "../utils/contracts";
import { createBlobCache, browserPersistence } from "../lib/blob-cache";
import { walkChain } from "../lib/walk";
import { encodePost, validatePostDraft } from "../lib/wire";
import { threadRegistryId } from "../lib/registry";
import { NO_WRITE_SESSION } from "../lib/publish";
import { usePublisher } from "./usePublisher";
import { gatewayFetcher } from "../lib/gateways";

/**
 * Replies, on the migrated content model.
 *
 * ⚠️ `Replies.sol` IS DELETED. This hook used to call
 * `addReply(parentContract, entityType, entityIndex, content, parentReplyIndex)` and a family of
 * `getTopLevelReplyCount` / `getChildReplies` getters on a shared per-entity-type contract. Aliased
 * onto `PostRegistry` during the migration those calls hit a contract with no such functions, and
 * surfaced on every expanded post as:
 *
 *   execution reverted (no data present; likely require(false) occurred …
 *   data="0x790aac2f000000000000000000000000f6dac4bc…"   ← Replies.addReply(...)
 *
 * That is the FOURTH appearance of one bug — after `getThreadCount`, `getUserPostCount` and
 * `Voting.getEntityId`. A selector naming a function the target does not have is always an
 * un-migrated hook, never a broken contract. The frontend CLAUDE.md keeps the table.
 *
 * THE MODEL NOW — a reply is a Post whose registry IS the thread (architecture §2).
 *
 *   registry = threadRegistryId(parentCid) = keccak256("thread:" + parentCid)   ← lib/registry.ts
 *   read     = PostRegistry.getHeadsPaged(registry, 0, N)  +  walkChain
 *   write    = publisher.publish({ registry, group: <the board>, build: encodePost })
 *
 * Several heads is NORMAL, not an error: there is one head per (registry, writer), so a thread with
 * five repliers has five valid heads and `walkChain` merges the branches by claimed timestamp.
 *
 * ⛔ NESTING IS GONE, AND IT IS NOT COMING BACK BY ACCIDENT. The wire format gives a `post` exactly
 * one link — `prev`, its position in a chain — and no parent pointer. `parentReplyIndex` and `depth`
 * are therefore not representable, and inventing a field to carry them would fork the format for one
 * feature. Replies are a single flat level; the reply-to-a-reply controls were removed rather than
 * left to fail. If threading is wanted later, the honest shape is a nested registry
 * (`thread:<replyCid>`), which this derivation already supports for free.
 *
 * ⚠️ Timestamps here are epoch MILLISECONDS, like every other migrated surface. `HeadRef.movedAt` is
 * SECONDS and is converted at this boundary; `formatTimestamp` must not multiply again.
 */

/** Matches PostRegistry's `HeadRef` tuple. ⚠️ `movedAt`, never `at` — see usePublisher. */
interface OnChainHead {
  cid: string;
  prev: string;
  storeBlock: bigint;
  movedAt: bigint;
  by: string;
  allowed: boolean;
}

/** How many reply chains and how many replies we pull in one pass. */
const PAGE = 50;

interface UseRepliesProps {
  /** The PostRegistry address. Named for the old contract so callers need no change. */
  repliesAddress: string | null;
  /**
   * The CID of the thing being replied to — a thread ANNOUNCEMENT's cid, or a profile post's cid.
   * Null while it is unknown, which is a real state: a head whose body has not resolved has no id.
   */
  parentCid: string | null;
  /**
   * The board or feed this conversation belongs to, used as `HeadSet.group`.
   *
   * That is exactly what the group parameter is for, per PostRegistry's docstring: one board
   * subscription then hears the board's own chain AND every reply on it. Omitting it routes the
   * event to the reply registry itself, which is correct but noisier to subscribe to.
   */
  group?: string;
  provider: Provider | null;
  /** ⛔ Unused for writes. Kept only because callers still thread it through for voting. */
  signer?: Signer | null;
  getDisplayName?: (address: string) => Promise<string>;
  enabled?: boolean;
}

interface UseRepliesReturn {
  replies: Reply[];
  /** ⚠️ Replies LOADED, not replies that exist. A page is capped and history can expire. */
  replyCount: number;
  isLoading: boolean;
  error: string | null;
  /** False when this session cannot write. Gate the composer on THIS, never on `signer`. */
  canReply: boolean;
  /** The `bytes32` these replies live in, or null when the parent has no CID. Useful for debugging. */
  registryId: string | null;

  addReply: (content: string) => Promise<void>;
  editReply: (replyIndex: number, newContent: string) => Promise<void>;
  deleteReply: (replyIndex: number) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useReplies({
  repliesAddress,
  parentCid,
  group,
  provider,
  getDisplayName,
  enabled = true,
}: UseRepliesProps): UseRepliesReturn {
  // `null` when this session cannot write. Not an error — see `usePublisher`.
  const publisher = usePublisher();
  const [replies, setReplies] = useState<Reply[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pollIntervalRef = useRef<number | null>(null);

  /** Derived in exactly one place — `lib/registry.ts`. Null parent ⇒ null id ⇒ no reads, no writes. */
  const registryId = useMemo(() => threadRegistryId(parentCid), [parentCid]);

  // Bodies are immutable and content-addressed, so a cache hit can never be stale — only absent.
  const cache = useMemo(
    () => createBlobCache({ fetcher: gatewayFetcher(), persist: browserPersistence() }),
    []
  );

  const getReadContract = useCallback(
    () => createReadContract(repliesAddress, PostRegistryABI.abi, provider),
    [repliesAddress, provider]
  );

  const loadReplies = useCallback(async () => {
    const contract = getReadContract();
    if (!contract || !registryId) {
      setReplies([]);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      // One head per replier, sorted newest-first by the contract. Cost grows with the number of
      // people who replied, not with the number of replies.
      const [refs] = await contract.getHeadsPaged(registryId, 0, PAGE);

      const heads = (refs as OnChainHead[])
        // A writer banned after the fact keeps their row; moderation is a write gate plus a hide
        // flag, never a delete, because freeing storage would refund the wrong person.
        .filter((ref) => ref.allowed && ref.cid)
        .map((ref) => ({
          cid: ref.cid,
          prev: ref.prev || null,
          // ⚠️ SECONDS on chain, milliseconds everywhere above this line.
          at: ref.movedAt > 0n ? Number(ref.movedAt) * 1000 : null,
          by: ref.by,
          block: ref.storeBlock > 0n ? Number(ref.storeBlock) : null,
          index: null,
        }));

      if (heads.length === 0) {
        setReplies([]);
        return;
      }

      const page = await walkChain({ heads, cache, limit: PAGE });

      // `walkChain` emits newest-first across the merged branches. A conversation reads oldest-first,
      // so reverse HERE rather than asking the walk for a different order — the merge has to be
      // newest-first to be a k-way merge at all.
      const ordered = [...page.entries].reverse();

      const formatted = await Promise.all(
        ordered.map(async (entry, index): Promise<Reply> => {
          const decoded = entry.object;
          // `decoded.author` is what the object CLAIMS; `entry.author` is the index's attribution,
          // which is the only one that is actually authenticated. Prefer the object, fall back.
          const author = decoded?.author || entry.author || "";

          let displayName: string | undefined;
          if (getDisplayName && author) {
            try {
              displayName = await getDisplayName(author);
            } catch {
              displayName = undefined;
            }
          }

          // A hole: the body expired from Bulletin, or no gateway would serve it. The pointer is
          // still on chain, so the reply is real — it is the CONTENT that is gone, and calling that
          // "deleted" would be wrong. Retention expiry is this design's only deletion mechanism.
          const content = !decoded
            ? "(this reply's body has expired from Bulletin storage)"
            : decoded.kind === "post" || decoded.kind === "msg"
              ? decoded.body
              : decoded.kind === "thread"
                ? decoded.excerpt
                : "";

          return {
            index,
            cid: entry.cid,
            author,
            sender: entry.author || author,
            content,
            timestamp: decoded?.at ?? entry.at ?? 0,
            editedAt: null,
            isDeleted: false,
            displayName,
          };
        })
      );

      setReplies(formatted);
    } catch (err) {
      console.error("Failed to load replies:", err);
      setError(err instanceof Error ? err.message : "Failed to load replies");
    } finally {
      setIsLoading(false);
    }
  }, [getReadContract, registryId, cache, getDisplayName]);

  const addReply = useCallback(
    async (content: string): Promise<void> => {
      if (!enabled) throw new Error("Replying is turned off in this view.");
      if (!publisher) throw new Error(NO_WRITE_SESSION);
      if (!registryId) {
        throw new Error(
          "This post has no CID yet, so there is no reply chain to write into. Wait for it to load."
        );
      }

      // Validated BEFORE anything is stored, so an over-long reply is refused at the field that can
      // fix it rather than after a Bulletin write has already been paid for.
      const draft = validatePostDraft({ body: content });

      // Body to Bulletin, THEN the pointer — `publisher.publish` owns that order and it is
      // load-bearing. Do not hand-roll it. `group` is the board, so one board subscription hears
      // this reply too.
      const { confirmed } = await publisher.publish({
        registry: registryId,
        group,
        cache,
        label: "reply",
        build: (link) =>
          encodePost({
            ...link,
            author: publisher.author,
            body: draft.body,
            attachments: draft.attachments,
            // `i` lets a reply count be read off the head object without walking the chain. It is a
            // LOWER BOUND: two repliers can concurrently produce the same index (architecture §2).
            index: replies.length,
            registry: registryId,
          }),
      });

      await loadReplies();
      if (!confirmed) {
        // The write went through — the head move returned a transaction hash — but the read RPC had
        // not caught up. Saying so beats a list that silently has not changed yet.
        throw new Error(
          "Your reply was submitted, but it has not shown up in a read yet. It should appear " +
            "within a minute; replies refresh on their own."
        );
      }
    },
    [enabled, publisher, registryId, group, cache, replies.length, loadReplies]
  );

  const editReply = useCallback(async (): Promise<void> => {
    // Bodies are immutable Bulletin objects. An "edit" is a NEW object with a new CID — and so a
    // new, empty vote tally, deliberately: a tally belongs to the bytes people actually voted on.
    throw new Error(
      "Editing is not wired up yet. A Bulletin object cannot be changed, so an edit publishes a " +
        "replacement — and what that should do to existing votes is not decided."
    );
  }, []);

  const deleteReply = useCallback(async (): Promise<void> => {
    throw new Error(
      "Deleting is not available, and will not work the way it used to: freeing storage refunds " +
        "whoever freed it, so a moderated delete would hand an admin the author's deposit. Content " +
        "goes away by stopping renewal instead."
    );
  }, []);

  useEffect(() => {
    if (repliesAddress && provider && registryId) {
      loadReplies();
    } else {
      setReplies([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repliesAddress, provider, registryId]);

  // Polling, NOT log subscriptions. `eth_getLogs` cannot see events from host-submitted contract
  // calls — the host submits native `Revive` extrinsics, which emit `Revive.ContractEmitted` in
  // `System.Events` and nothing in the ETH log index (architecture §8). Do not "modernise" this.
  useEffect(() => {
    if (!repliesAddress || !provider || !registryId) return;
    pollIntervalRef.current = window.setInterval(() => void loadReplies(), 30000);
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [repliesAddress, provider, registryId, loadReplies]);

  return {
    replies,
    replyCount: replies.length,
    isLoading,
    error,
    canReply: enabled && publisher !== null,
    registryId,
    addReply,
    editReply,
    deleteReply,
    refresh: loadReplies,
  };
}
