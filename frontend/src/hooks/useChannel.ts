import { useState, useCallback, useEffect, useRef } from "react";
import type { Message, FormattedMessage, ChannelInfo, PostingMode } from "../types/contracts";
import ChatChannelABI from "../contracts/ChatChannel.json";
import { formatTimestamp } from "../utils/formatters";
import { createReadContract, createWriteContract, type Provider, type Signer } from "../utils/contracts";

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
  isLoading: boolean;
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
  const [error, setError] = useState<string | null>(null);

  const pollIntervalRef = useRef<number | null>(null);
  const hasAttemptedDisplayNameFetch = useRef(false);
  // Ref to always have the latest loadMessages function for polling
  const loadMessagesRef = useRef<(() => Promise<void>) | null>(null);

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

  const loadMessages = useCallback(async () => {
    const contract = getReadContract();
    if (!contract) {
      setMessages([]);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const count = await contract.getMessageCount();
      if (count === 0n) {
        setMessages([]);
        return;
      }

      // Load latest 50 messages
      const limit = count > 50n ? 50n : count;
      const rawMessages = await contract.getLatestMessages(limit);

      // Format messages and optionally resolve display names
      const formatted: FormattedMessage[] = await Promise.all(
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

      setMessages(formatted);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load messages");
    } finally {
      setIsLoading(false);
    }
  }, [getReadContract, getDisplayName]);

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
        await loadMessages();
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
      loadMessages();
      loadChannelInfo();
    } else {
      setMessages([]);
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
      loadMessages();
    }
  }, [channelAddress, provider, getDisplayName, enabled, messages, loadMessages]);

  // Poll for new messages every 15 seconds
  // Uses ref to always call the latest version of loadMessages
  useEffect(() => {
    if (!channelAddress || !provider) return;

    pollIntervalRef.current = window.setInterval(() => {
      loadMessagesRef.current?.();
    }, 15000);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [channelAddress, provider]);

  return {
    messages,
    channelInfo,
    isLoading,
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
