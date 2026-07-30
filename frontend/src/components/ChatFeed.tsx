import { useEffect, useRef, useState } from 'react';
import type { FormattedMessage, Profile } from '../types/contracts';
import type { Provider } from '../utils/contracts';
import { formatTimestamp } from '../utils/formatters';
import { UserLink } from './UserAddress';

interface ChatFeedProps {
  messages: FormattedMessage[];
  isLoading: boolean;
  currentAddress: string | null;
  currentUserDisplayName?: string | null;
  onSelectUser?: (address: string) => void;
  // Tooltip props
  getProfile?: (address: string) => Promise<Profile>;
  provider?: Provider | null;
  onFollow?: (address: string) => Promise<void>;
  onUnfollow?: (address: string) => Promise<void>;
  isFollowing?: (address: string) => boolean;
  onTip?: (address: string) => void;
  canTip?: boolean;
}

export function ChatFeed({
  messages,
  isLoading,
  currentAddress,
  currentUserDisplayName,
  onSelectUser,
  getProfile,
  provider,
  onFollow,
  onUnfollow,
  isFollowing,
  onTip,
  canTip = false,
}: ChatFeedProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Track if we've completed the initial load
  useEffect(() => {
    if (!isLoading) {
      setHasLoadedOnce(true);
    }
  }, [isLoading]);

  // Only show loading state if we haven't loaded at least once
  if (isLoading && !hasLoadedOnce) {
    return (
      <div className="flex-1 flex items-center justify-center bg-black p-8">
        <div className="text-primary-500 font-mono text-center">
          <div className="text-2xl mb-4 terminal-cursor">...</div>
          <div className="text-sm text-shadow-neon-sm">LOADING MESSAGES...</div>
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-black p-8">
        <div className="text-center font-mono">
          <div className="text-primary-500 text-lg mb-2 text-shadow-neon">
            [EMPTY CHAT ROOM]
          </div>
          <div className="text-primary-700 text-sm">
            &gt; Be the first to post a message_
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-black p-4 space-y-2">
      {messages.map((msg, index) => {
        const isCurrentUser = msg.profileOwner.toLowerCase() === currentAddress?.toLowerCase();
        const displayName = isCurrentUser
          ? (currentUserDisplayName || msg.displayName)
          : msg.displayName;
        return (
          <div key={index} className="w-full max-w-4xl font-mono text-sm text-primary-400">
            <span className="text-primary-600 text-xs">
              {/* `* 1000`: a Solidity seconds timestamp, from the un-migrated chat path. */}
              [ {formatTimestamp(msg.timestamp * 1000)} ]
            </span>
            {' '}
            {onSelectUser && (
              <UserLink
                address={msg.profileOwner}
                displayName={displayName}
                onSelectUser={onSelectUser}
                isCurrentUser={isCurrentUser}
                getProfile={getProfile}
                provider={provider}
                onFollow={onFollow}
                onUnfollow={onUnfollow}
                isFollowing={isFollowing?.(msg.profileOwner)}
                onTip={onTip}
                canTip={canTip}
              />
            )}
            <span className="text-primary-600"> : </span>
            <span className="text-primary-300">{msg.content}</span>
          </div>
        );
      })}
      <div ref={messagesEndRef} />
    </div>
  );
}
