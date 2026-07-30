import { useMemo } from 'react';
import type { FormattedMessage, Profile } from '../types/contracts';
import type { Provider } from '../utils/contracts';
import { UserLink } from './UserAddress';

interface ChannelUser {
  address: string;
  displayName?: string;
  lastPostTime: number;
  messageCount: number;
}

interface UserListPanelProps {
  messages: FormattedMessage[];
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

export function UserListPanel({
  messages,
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
}: UserListPanelProps) {
  const users = useMemo(() => {
    const userMap = new Map<string, ChannelUser>();

    for (const msg of messages) {
      const addr = msg.profileOwner.toLowerCase();
      const existing = userMap.get(addr);

      if (!existing) {
        userMap.set(addr, {
          address: msg.profileOwner,
          displayName: msg.displayName,
          lastPostTime: msg.timestamp,
          messageCount: 1,
        });
      } else {
        existing.messageCount++;
        if (msg.timestamp > existing.lastPostTime) {
          existing.lastPostTime = msg.timestamp;
          if (msg.displayName) {
            existing.displayName = msg.displayName;
          }
        }
      }
    }

    return Array.from(userMap.values()).sort(
      (a, b) => b.lastPostTime - a.lastPostTime
    );
  }, [messages]);

  const currentAddrLower = currentAddress?.toLowerCase();

  return (
    <div className="w-56 border-l-2 border-primary-500 bg-black flex flex-col">
      {/* Header */}
      <div className="p-4 border-b-2 border-primary-700">
        <h2 className="text-primary-500 font-mono text-sm font-bold">
          USERS <span className="text-primary-700">({users.length})</span>
        </h2>
      </div>

      {/* User list */}
      <div className="flex-1 overflow-y-auto">
        {users.length === 0 ? (
          <div className="p-4 text-primary-700 font-mono text-sm">
            No messages yet
          </div>
        ) : (
          <div className="py-2">
            {users.map((user) => {
              const isCurrentUser =
                user.address.toLowerCase() === currentAddrLower;
              const displayName = isCurrentUser
                ? (currentUserDisplayName || user.displayName)
                : user.displayName;

              return (
                <div
                  key={user.address}
                  className="w-full px-4 py-1.5 bg-black font-mono text-sm flex items-center gap-2 hover:bg-primary-950 transition-all"
                >
                  <span
                    className={
                      isCurrentUser ? 'text-accent-400' : 'text-primary-600'
                    }
                  >
                    ●
                  </span>
                  {onSelectUser && (
                    <UserLink
                      address={user.address}
                      displayName={displayName}
                      onSelectUser={onSelectUser}
                      isCurrentUser={isCurrentUser}
                      getProfile={getProfile}
                      provider={provider}
                      onFollow={onFollow}
                      onUnfollow={onUnfollow}
                      isFollowing={isFollowing?.(user.address)}
                      onTip={onTip}
                      canTip={canTip}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
