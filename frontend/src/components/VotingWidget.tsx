import { useState, useEffect, useCallback } from 'react';
import type { VoteType, VoteTally } from '../types/contracts';
import { VoteType as VoteTypeEnum } from '../types/contracts';

interface VotingWidgetProps {
  entityId: string;
  getVoteTally: (entityId: string) => Promise<VoteTally>;
  getUserVote: (entityId: string) => Promise<VoteType>;
  vote: (entityId: string, voteType: VoteType) => Promise<void>;
  removeVote: (entityId: string) => Promise<void>;
  isVoting: boolean;
  disabled?: boolean;
  compact?: boolean;
}

export function VotingWidget({
  entityId,
  getVoteTally,
  getUserVote,
  vote,
  removeVote,
  isVoting,
  disabled = false,
  compact = false,
}: VotingWidgetProps) {
  const [tally, setTally] = useState<VoteTally>({ upvotes: 0, downvotes: 0, score: 0 });
  const [userVote, setUserVote] = useState<VoteType>(VoteTypeEnum.None);
  const [isLoading, setIsLoading] = useState(true);

  const loadVoteData = useCallback(async () => {
    if (!entityId) return;

    try {
      const [tallyData, voteData] = await Promise.all([
        getVoteTally(entityId),
        getUserVote(entityId),
      ]);
      setTally(tallyData);
      setUserVote(voteData);
    } catch (err) {
      console.error('Failed to load vote data:', err);
    } finally {
      setIsLoading(false);
    }
  }, [entityId, getVoteTally, getUserVote]);

  useEffect(() => {
    loadVoteData();
  }, [loadVoteData]);

  const handleVote = async (voteType: VoteType) => {
    if (disabled || isVoting) return;

    try {
      if (userVote === voteType) {
        // Same vote clicked - remove it
        await removeVote(entityId);
        setUserVote(VoteTypeEnum.None);
        // Optimistic update
        setTally(prev => ({
          ...prev,
          upvotes: voteType === VoteTypeEnum.Up ? prev.upvotes - 1 : prev.upvotes,
          downvotes: voteType === VoteTypeEnum.Down ? prev.downvotes - 1 : prev.downvotes,
          score: voteType === VoteTypeEnum.Up ? prev.score - 1 : prev.score + 1,
        }));
      } else {
        // New or changed vote
        await vote(entityId, voteType);
        const prevVote = userVote;
        setUserVote(voteType);
        // Optimistic update
        setTally(prev => {
          let newUpvotes = prev.upvotes;
          let newDownvotes = prev.downvotes;

          // Remove previous vote effect
          if (prevVote === VoteTypeEnum.Up) newUpvotes--;
          if (prevVote === VoteTypeEnum.Down) newDownvotes--;

          // Add new vote effect
          if (voteType === VoteTypeEnum.Up) newUpvotes++;
          if (voteType === VoteTypeEnum.Down) newDownvotes++;

          return {
            upvotes: newUpvotes,
            downvotes: newDownvotes,
            score: newUpvotes - newDownvotes,
          };
        });
      }
    } catch (err) {
      console.error('Vote failed:', err);
      // Reload actual data on error
      await loadVoteData();
    }
  };

  if (isLoading) {
    return (
      <div className={`flex ${compact ? 'flex-row gap-1' : 'flex-col'} items-center font-mono text-xs text-primary-600`}>
        <span className="opacity-50">...</span>
      </div>
    );
  }

  const isUpvoted = userVote === VoteTypeEnum.Up;
  const isDownvoted = userVote === VoteTypeEnum.Down;

  return (
    <div className={`flex ${compact ? 'flex-row gap-1' : 'flex-col'} items-center font-mono`}>
      <button
        onClick={() => handleVote(VoteTypeEnum.Up)}
        disabled={disabled || isVoting}
        className={`
          px-1 py-0.5 text-sm transition-colors
          ${isUpvoted
            ? 'text-accent-400 font-bold hover:text-accent-300'
            : 'text-primary-600 hover:text-primary-400'}
          ${disabled || isVoting ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
        `}
        title={isUpvoted ? 'Remove upvote' : 'Upvote'}
      >
        ▲
      </button>

      <span className={`
        text-xs px-1 min-w-[2rem] text-center
        ${tally.score > 0 ? 'text-accent-400' : tally.score < 0 ? 'text-red-400' : 'text-primary-500'}
      `}>
        {tally.score}
      </span>

      <button
        onClick={() => handleVote(VoteTypeEnum.Down)}
        disabled={disabled || isVoting}
        className={`
          px-1 py-0.5 text-sm transition-colors
          ${isDownvoted
            ? 'text-red-400 font-bold hover:text-red-300'
            : 'text-primary-600 hover:text-primary-400'}
          ${disabled || isVoting ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
        `}
        title={isDownvoted ? 'Remove downvote' : 'Downvote'}
      >
        ▼
      </button>
    </div>
  );
}
