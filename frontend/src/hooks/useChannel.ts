import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { Message, FormattedMessage, ChannelInfo, PostingMode } from "../types/contracts";
import ChatChannelABI from "../contracts/ChatChannel.json";
import { formatTimestamp } from "../utils/formatters";
import { createReadContract, createWriteContract, type Provider, type Signer } from "../utils/contracts";
import { createRefreshGate, refresh, startPolling, type RefreshMode } from "../lib/poll";

/**
 * ⛔ THIS HOOK IS PARKED. It still calls the DELETED `ChatChannel` contract, has zero importers, and
 * every call it makes reverts. It is on disk as the starting point for the chat migration.
 *
 * It is nevertheless on `lib/poll.ts` like the other three list hooks, because the flicker bug it
 * shares with them — a 30-second interval re-entering the cold loader, which announces loading and
 * empties the array before it fetches — must not survive anywhere in the codebase to be copied out
 * of. When chat is migrated to `PostRegistry` + `walkChain`, the polling half is already correct.
 */

/**
 * Chat polls faster than the boards do — a conversation is a worse experience 30 seconds stale than
 * a forum list is. Deliberately NOT `POLL_INTERVAL_MS`; the divergence is the point.
 */
const CHAT_POLL_INTERVAL_MS = 15_000;

interface UseChannelProps {
  channelAddress: string | null;
  provider: Provider | null;
  appWallet?: Signer | null;
  getDisplayName?: (address: string) => Promise<string>;
  enabled?: boolean;
}

interface UseChannelReturn {
  // State
  messages: FormattedMessage[];
  channelInfo: ChannelInfo | null;
  /** True only for a COLD load — nothing on screen yet. */
  isLoading: boolean;
  /**
   * True while a BACKGROUND poll is in flight, with the previous messages still on screen.
   *
   * ⚠️ NEVER unmount the message list on this — see `lib/poll.ts`.
   */
  isRefreshing: boolean;
  error: string | null;

  // Actions
  postMessage: (content: string) => Promise<void>;
  loadMessages: () => Promise<void>;
  loadChannelInfo: () => Promise<void>;

  // Moderation
  isAdmin: (address: string) => Promise<boolean>;
  isAllowedPoster: (address: string) => Promise<boolean>;
  addAllowedPoster: (address: string) => Promise<void>;
  removeAllowedPoster: (address: string) => Promise<void>;
  promoteAdmin: (address: string) => Promise<void>;
  demoteAdmin: (address: string) => Promise<void>;
  transferOwnership: (newOwner: string) => Promise<void>;
  setPostingMode: (mode: PostingMode) => Promise<void>;
}

export function useChannel({
  channelAddress,
  provider,
  appWallet,
  getDisplayName,
  enabled = true,
}: UseChannelProps): UseChannelReturn {
  const [messages, setMessages] = useState<FormattedMessage[]>([]);
  const [channelInfo, setChannelInfo] = useState<ChannelInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasAttemptedDisplayNameFetch = useRef(false);
  // Ref to always have the latest loadMessages function for polling
  const loadMessagesRef = useRef<((mode?: RefreshMode) => Promise<void>) | null>(null);

  /**
   * The last committed message list, mirrored into a ref.
   *
   * ⚠️ THE EQUALITY SKIP MUST READ THIS, NOT `messages` — a `useCallback` closes over the `messages`
   * of the render that created it. Everything that writes `messages` goes through `commitMessages`.
   */
  const messagesRef = useRef<FormattedMessage[]>([]);
  const commitMessages = useCallback((next: FormattedMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  /**
   * Orders concurrent refreshes so a slow one cannot overwrite a newer one. Without it: the poll
   * starts fetching, the user sends a message, the post-write reload commits it — and then the
   * poll's PRE-WRITE snapshot resolves and rolls the room back, silently.
   * See `lib/poll.ts` § RefreshGate.
   */
  const gate = useMemo(() => createRefreshGate(), []);

  const getReadContract = useCallback(() => {
    return createReadContract(channelAddress, ChatChannelABI.abi, provider);
  }, [channelAddress, provider]);

  const getWriteContract = useCallback(async () => {
    return createWriteContract(channelAddress, ChatChannelABI.abi, provider, appWallet ?? null);
  }, [channelAddress, provider, appWallet]);

  const loadChannelInfo = useCallback(async () => {
    const contract = getReadContract();
    if (!contract) return;

    try {
      const info = await contract.getChannelInfo();
      setChannelInfo({
        name: info._name,
        description: info._description,
        motd: info._motd,
        owner: info._owner,
        postingMode: Number(info._postingMode) as PostingMode,
        messageCount: info._messageCount,
      });
    } catch (err) {
      console.error("Failed to load channel info:", err);
    }
  }, [getReadContract]);

  /** The FETCH half: reads and returns a list. It touches no state and announces nothing. */
  const fetchMessages = useCallback(async (): Promise<FormattedMessage[]> => {
    const contract = getReadContract();
    if (!contract) return [];

    const count = await contract.getMessageCount();
    // An empty room is a RESULT, not a failure — returned and diffed like any other.
    if (count === 0n) return [];

    // Load latest 50 messages
    const limit = count > 50n ? 50n : count;
    const rawMessages = await contract.getLatestMessages(limit);

    // Format messages and optionally resolve display names
    return Promise.all(
      rawMessages.map(async (msg: Message) => {
        let displayName: string | undefined;
        if (getDisplayName) {
          try {
            displayName = await getDisplayName(msg.profileOwner);
          } catch {
            displayName = undefined;
          }
        }

        return {
          profileOwner: msg.profileOwner,
          sender: msg.sender,
          content: msg.content,
          timestamp: Number(msg.timestamp),
          // `* 1000` because this is a Solidity `block.timestamp`, in SECONDS, while
          // `formatTimestamp` takes epoch ms like the rest of the migrated data layer.
          formattedTime: formatTimestamp(Number(msg.timestamp) * 1000),
          displayName,
        };
      })
    );
  }, [getReadContract, getDisplayName]);

  /**
   * The ANNOUNCE half. `mode` decides whether this load may blank the screen.
   *
   * - `"cold"` — nothing on screen yet, or the channel changed.
   * - `"background"` — the poll. Keeps the current messages up, raises `isRefreshing`, commits only
   *   on a real change, and on failure keeps the last good list.
   *
   * ⛔ Never infer the mode from `messages.length === 0`; see `lib/poll.ts`.
   */
  const loadMessages = useCallback(
    async (mode: RefreshMode = "cold"): Promise<void> => {
      if (!getReadContract()) {
        if (mode === "cold") commitMessages([]);
        return;
      }
      await refresh<FormattedMessage[]>({
        mode,
        gate,
        sinks: {
          setData: commitMessages,
          setLoading: setIsLoading,
          setRefreshing: setIsRefreshing,
          setError,
        },
        load: fetchMessages,
        previous: () => messagesRef.current,
        message: (err) => (err instanceof Error ? err.message : "Failed to load messages"),
      });
    },
    [getReadContract, fetchMessages, commitMessages]
  );

  // Keep the ref updated with the latest loadMessages function
  useEffect(() => {
    loadMessagesRef.current = loadMessages;
  }, [loadMessages]);

  const postMessage = useCallback(
    async (content: string) => {
      if (!enabled) throw new Error("Wallet not ready");
      if (!content.trim()) {
        throw new Error("Message cannot be empty");
      }

      const contract = await getWriteContract();
      if (!contract) {
        throw new Error("Contract not available");
      }

      try {
        const tx = await contract.postMessage(content);
        await tx.wait();
        // BACKGROUND: the room is already on screen and this read adds one line to it.
        await loadMessages("background");
      } catch (err) {
        throw err instanceof Error ? err : new Error("Failed to post message");
      }
    },
    [enabled, getWriteContract, loadMessages]
  );

  // Moderation functions
  const isAdmin = useCallback(
    async (address: string): Promise<boolean> => {
      const contract = getReadContract();
      if (!contract) return false;
      return contract.isAdmin(address);
    },
    [getReadContract]
  );

  const isAllowedPoster = useCallback(
    async (address: string): Promise<boolean> => {
      const contract = getReadContract();
      if (!contract) return false;
      return contract.isAllowedPoster(address);
    },
    [getReadContract]
  );

  const addAllowedPoster = useCallback(
    async (address: string): Promise<void> => {
      if (!enabled) throw new Error("Wallet not ready");
      const contract = await getWriteContract();
      if (!contract) throw new Error("Contract not available");
      const tx = await contract.addAllowedPoster(address);
      await tx.wait();
    },
    [enabled, getWriteContract]
  );

  const removeAllowedPoster = useCallback(
    async (address: string): Promise<void> => {
      if (!enabled) throw new Error("Wallet not ready");
      const contract = await getWriteContract();
      if (!contract) throw new Error("Contract not available");
      const tx = await contract.removeAllowedPoster(address);
      await tx.wait();
    },
    [enabled, getWriteContract]
  );

  const promoteAdmin = useCallback(
    async (address: string): Promise<void> => {
      if (!enabled) throw new Error("Wallet not ready");
      const contract = await getWriteContract();
      if (!contract) throw new Error("Contract not available");
      const tx = await contract.promoteAdmin(address);
      await tx.wait();
    },
    [enabled, getWriteContract]
  );

  const demoteAdmin = useCallback(
    async (address: string): Promise<void> => {
      if (!enabled) throw new Error("Wallet not ready");
      const contract = await getWriteContract();
      if (!contract) throw new Error("Contract not available");
      const tx = await contract.demoteAdmin(address);
      await tx.wait();
    },
    [enabled, getWriteContract]
  );

  const transferOwnership = useCallback(
    async (newOwner: string): Promise<void> => {
      if (!enabled) throw new Error("Wallet not ready");
      const contract = await getWriteContract();
      if (!contract) throw new Error("Contract not available");
      const tx = await contract.transferOwnership(newOwner);
      await tx.wait();
      await loadChannelInfo();
    },
    [enabled, getWriteContract, loadChannelInfo]
  );

  const setPostingMode = useCallback(
    async (mode: PostingMode): Promise<void> => {
      if (!enabled) throw new Error("Wallet not ready");
      const contract = await getWriteContract();
      if (!contract) throw new Error("Contract not available");
      const tx = await contract.setPostingMode(mode);
      await tx.wait();
      await loadChannelInfo();
    },
    [enabled, getWriteContract, loadChannelInfo]
  );

  // Reset display name fetch flag when channel changes or view becomes enabled
  useEffect(() => {
    if (enabled) {
      hasAttemptedDisplayNameFetch.current = false;
    }
  }, [channelAddress, enabled]);

  // Load messages and channel info when channel changes
  useEffect(() => {
    if (channelAddress && provider) {
      // COLD, and the only cold entry point: a different room's messages must not be preserved.
      void loadMessages("cold");
      loadChannelInfo();
    } else {
      commitMessages([]);
      setChannelInfo(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelAddress, provider]);

  // Re-fetch messages with display names when getDisplayName becomes available or view becomes enabled
  useEffect(() => {
    if (!channelAddress || !provider || !getDisplayName || !enabled) return;
    if (messages.length === 0) return;
    if (hasAttemptedDisplayNameFetch.current) return;

    // Check if any messages are missing display names
    const hasMissingNames = messages.some(m => !m.displayName);

    if (hasMissingNames) {
      hasAttemptedDisplayNameFetch.current = true;
      // BACKGROUND: the list is already painted and this pass only decorates it with names.
      void loadMessages("background");
    }
  }, [channelAddress, provider, getDisplayName, enabled, messages, loadMessages]);

  // Poll for new messages every 15 seconds — chat wants a shorter period than the 30s boards.
  // Uses ref to always call the latest version of loadMessages.
  //
  // ⛔ THE TICK IS ALWAYS `"background"`. A cold tick empties the room four times a minute.
  useEffect(() => {
    if (!channelAddress || !provider) return;
    return startPolling(() => void loadMessagesRef.current?.("background"), {
      intervalMs: CHAT_POLL_INTERVAL_MS,
    });
  }, [channelAddress, provider]);

  return {
    messages,
    channelInfo,
    isLoading,
    isRefreshing,
    error,
    postMessage,
    loadMessages,
    loadChannelInfo,
    // Moderation
    isAdmin,
    isAllowedPoster,
    addAllowedPoster,
    removeAllowedPoster,
    promoteAdmin,
    demoteAdmin,
    transferOwnership,
    setPostingMode,
  };
}
