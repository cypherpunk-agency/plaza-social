// ============ UserRegistry Types ============

export interface Link {
  name: string;
  url: string;
}

export interface Profile {
  owner: string;
  displayName: string;
  bio: string;
  exists: boolean;
}

// ============ ChatChannel Types ============

// On-chain posting mode (stored in contract)
export const PostingMode = {
  Open: 0,
  Permissioned: 1,
} as const;

export type PostingMode = (typeof PostingMode)[keyof typeof PostingMode];

// Channel type for creation UI (includes unlisted option)
export const ChannelType = {
  Open: 'open',           // Anyone can post, listed in registry
  Permissioned: 'permissioned',  // Only allowed posters, listed in registry
  Unlisted: 'unlisted',   // Anyone can post, NOT listed in registry
} as const;

export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType];

export interface Message {
  profileOwner: string;
  sender: string;
  content: string;
  timestamp: bigint;
}

export interface FormattedMessage {
  profileOwner: string;
  sender: string;
  content: string;
  timestamp: number;
  formattedTime: string;
  displayName?: string;
}

export interface ChannelInfo {
  name: string;
  description: string;
  motd: string;
  owner: string;
  postingMode: PostingMode;
  messageCount: bigint;
}

// ============ ChannelRegistry Types ============

export interface RegisteredChannel {
  channelAddress: string;
  registeredBy: string;
  registeredAt: bigint;
}

// ============ App Wallet Types ============

export interface StoredWallet {
  privateKey: string;
  address: string;
  authorizedFor: string;
  createdAt: number;
}

// ============ UserPosts Types ============

export interface UserPost {
  index: number;
  /**
   * The Bulletin CID of this post's body — its real identity.
   *
   * ⚠️ `index` is a POSITION in the loaded page, not a stable id. There is no on-chain index any
   * more, only CIDs, so anything that must survive another post arriving (a vote tally, a deep
   * link) keys on this. See `lib/entity.ts`.
   */
  cid: string;
  profileOwner: string;
  sender: string;
  content: string;
  /** Epoch **milliseconds**. The whole migrated data layer is in ms; see `lib/wire.ts`. */
  timestamp: number;
  editedAt: number | null;
  isDeleted: boolean;
  displayName?: string;
}

// ============ Replies Types ============

/**
 * One reply, i.e. one `post` object in the reply registry of its parent (`lib/registry.ts`).
 *
 * ⛔ **REPLIES ARE FLAT.** `parentReplyIndex`, `depth` and `children` are gone and must not come
 * back as optional fields. The wire format gives a `post` one link — `prev`, its place in a chain —
 * and no parent pointer, so a reply-to-a-reply is not representable and a field carrying one would
 * be decoration that nothing on chain can enforce. See `hooks/useReplies.ts`.
 *
 * `parentId` is gone for the same reason it went from `Voting`: identity is the CID now, and the
 * parent is the REGISTRY the reply was written into, not a value stored inside it.
 */
export interface Reply {
  /**
   * Position in the loaded page, NOT a stable id — it changes when someone else replies. Anything
   * that must outlive that (a vote key, a link) uses `cid`.
   */
  index: number;
  /** The Bulletin CID of this reply's body — its real identity, and its vote key via `entityIdOfCid`. */
  cid: string;
  /** Who the object claims wrote it. */
  author: string;
  /** Who the INDEX attributes the head to. Unlike `author`, this one is authenticated. */
  sender: string;
  content: string;
  /** Epoch **milliseconds**. The whole migrated data layer is in ms; see `lib/wire.ts`. */
  timestamp: number;
  editedAt: number | null;
  isDeleted: boolean;
  displayName?: string;
}

// ============ Voting Types ============

export const VoteType = {
  None: 0,
  Up: 1,
  Down: 2,
} as const;

export type VoteType = (typeof VoteType)[keyof typeof VoteType];

export interface VoteTally {
  upvotes: number;
  downvotes: number;
  score: number;
}

// ============ ForumThread Types ============

export interface ForumThread {
  index: number;
  /** The CID of the thread ANNOUNCEMENT — its identity. See `UserPost.cid`. */
  cid: string;
  /**
   * The CID of the opening POST, which is where the body lives. A thread announcement carries no
   * body: it points at one. Empty when the announcement could not be resolved.
   */
  opCid: string;
  author: string;
  sender: string;
  title: string;
  content: string;
  /** Epoch **milliseconds**. The whole migrated data layer is in ms; see `lib/wire.ts`. */
  timestamp: number;
  editedAt: number | null;
  isDeleted: boolean;
  tags: string[];
  displayName?: string;
}
