# Frontend - Claude Code Guide

React frontend for Plaza, a decentralized social platform.

## Commands

```bash
npm run dev                 # Start Vite dev server (port 5173)
npm run build               # TypeScript compile + Vite build
npm run build:deploy        # Build with contract address injection for GitHub Pages
npm run lint                # ESLint check
npm run preview             # Preview production build
```

## URL Parameters & Persistence

The app uses URL parameters for deep linking and state persistence.

### Registry Addresses
- `?registry=0x...` — **PostRegistry** address (was ChannelRegistry, which no longer exists)
- `?followRegistry=0x...` — FollowRegistry address
- `?network=<key>` — override which `deployments.json` network is read

If not provided, addresses come from `public/deployments.json` under the key `products-devnet`.

⚠️ **The key must match.** `useDeployments` read `'polkadot-asset-hub-testnet'` — absent from that file
— so `currentNetwork` was always null, every address `undefined`, and every view rendered its
"contract not deployed" fallback *even after the contracts were deployed*. It now falls back to the
only network in a single-network file and surfaces an `error`, so a missing key can never again look
like a missing deployment.

### View Parameters

| Parameter | View Mode | Description |
|-----------|-----------|-------------|
| `?profile=0x...` | profile | Shows user profile (inline overlay) |
| `?thread=N` | forum | ⚠️ POSITIONAL — `N` is a slot in the loaded page, not a thread. Retargets when anyone posts. Moving to `?cid=`. |

`?channel=0x...` is **dead** — `ViewMode` has no `'channels'` member; such a link falls back to the
forum.

### How navigation actually works — state is the source of truth

⚠️ **This section previously described a mechanism that does not exist.** It claimed `openProfile()`
"handles URL updates and `previousViewState` tracking" and that clicking pushes the URL directly.
Neither is true, and `previousViewState` is not in the file at all. Someone hooking a new control
into navigation will go looking for a `pushState` inside `openProfile` and find nothing.

The real shape:

1. `openProfile()` sets **React state only** — it never touches the URL.
2. A separate `useEffect` derives the whole URL and the document title *from* state, diffs it against
   a `lastUrlRef`, and `pushState`s only on a real change. One place builds URLs; nothing else does.
3. Back works through a `popstate` listener that **re-derives state from the URL**. There is no saved
   snapshot to restore, which is why there is no `previousViewState`.

So: **state is the source of truth, the URL is a projection of it, and Back reverses it by re-reading
the URL.** Add a new deep-linkable thing by teaching the effect to project it and the popstate handler
to parse it — never by calling `pushState` from a click handler.

⚠️ **`viewMode` and `selectedProfile` are persisted to `localStorage`.** A "cold load" therefore lands
where you left off, not on the forum, and that looks exactly like a routing regression when you have
just been clicking around. Clear both before judging default-route behaviour.

⚠️ **Inside the host container the address bar is the SHELL's, not Plaza's.** Plaza runs in an iframe
(`plaza-social.app.dev-dot.li`) under `plaza-social.dev-dot.li`, so `pushState` updates a URL nobody
can see or copy. The shell **does** forward query and hash inbound (measured), so deep links work on
the way IN; sharing one OUT needs an explicit copy affordance. TruAPI offers `navigateTo(url)` for
following a link, and nothing at all for publishing the current URL.

### URL Persistence Config

By default, registry addresses are hidden from URL unless:
- User provided them in initial URL, OR
- `VITE_SHOW_REGISTRY_IN_URL=true` is set

## Key Hooks

| Hook | Purpose | State |
|------|---------|-------|
| `useHostSession` | **The host seam.** Capabilities, signer arms, delegate, diagnostics | current |
| `useDeployments` | Contract addresses from `deployments.json` | current |
| `useUserRegistry` | Profile CRUD, delegate management | ABI unchanged; reads work |
| `useFollowRegistry` | Following/follower management | ABI unchanged; reads work |
| `usePublisher` | **The write seam.** Turns `PostRegistry` into the three functions `lib/publish.ts` needs | current |
| `useForumThread` | Forum threads: `getHeadsPaged` + `walkChain`; `createThread` publishes | **migrated** |
| `useUserPosts` | Profile feed: `headOf(FEED_REGISTRY, user)` + `walkChain`; `createPost` publishes | **migrated** |
| `useChannelRegistry` | Channel listing/creation | ⛔ calls deleted `ChannelRegistry` |
| `useChannel` | Message loading, posting, moderation | ⛔ calls deleted `ChatChannel` |
| `useReplies` | Replies: `getHeadsPaged(threadRegistryId(cid))` + `walkChain`; `addReply` publishes | **migrated — and FLAT, see below** |
| `useVoting` | Upvote/downvote against the deployed `Voting`; takes an already-derived `bytes32` | **migrated** |

**⛔ rows call contracts that do not exist.** They cannot work, and they fail as `require(false)`
reverts rather than anything legible. Migrate them the way `useForumThread`, `useUserPosts` and
`useReplies` were:
heads from `PostRegistry` for a `bytes32` registry id, then `walkChain` over the Bulletin chain. Note
that **creating a channel is no longer deploying anything** — an open room is `keccak256(name)`, a
moderated one is `claimRegistry(salt, policy)`.

⛔ **The chat UI is UNREACHABLE, and the files are still here.** The Channels nav, the channels view,
and everything rendered only for it were removed from `Sidebar.tsx` and `App.tsx`. But no file was
deleted: `useChannel`, `useChannelRegistry`, `ChatFeed`, `MessageInput`, `ChannelHeader`,
`ChannelModerationModal`, `UserListPanel` and `CreateChannelModal` are all on disk with **zero
importers**, waiting for the migration. "The contract is deleted" and "the UI still calls it" are
different facts; both are true of different halves of this code.

⚠️ **`ViewMode` no longer has a `'channels'` member, and that is the enforcement.** Deleting the
render branches alone would have compiled fine and left a user with a persisted
`viewMode: 'channels'` staring at a blank screen. Narrowing the union is what makes the removal safe;
the branch deletions are cleanup. A stale `localStorage` value and a `?channel=0x…` link both fall
back to the forum (verified).

⭐ **The tell for this whole class of bug:** a call naming a function the target does not have. It has
appeared **four** times, in four disguises, and every time it was an un-migrated hook rather than a
broken contract:

| Symptom | Was |
|---|---|
| `execution reverted`, selector `0x9de12115` | `getThreadCount()` against `PostRegistry` |
| `execution reverted`, selector `0x00a09832` | `getUserPostCount(address)` against `PostRegistry` |
| `TypeError: T.getEntityId is not a function` | `Voting.getEntityId(...)` — ethers cannot even build the call, so it fails in JS rather than on chain |
| `execution reverted`, selector `0x790aac2f` | `Replies.addReply(address,uint8,uint256,string,uint256)` against `PostRegistry` |

The third is the friendliest of the four and the easiest to skip past, because it looks like a
frontend type error rather than a contract mismatch. It is the same bug.

The fourth carried a second, independent failure behind it: it was sent **from the delegate key**,
which is unauthorised and unfunded, so even a correct ABI would have died on
`code 1012 "Transaction is temporarily banned"`. Content writes go through `usePublisher`, never
through `signer`. If you are fixing one of these, check both halves.

**Identity is the CID now, not a position.** `Voting` keys tallies on `keccak256(utf8(cid))`, which is
`pure` — so `lib/entity.ts` computes it locally, cannot fail, and renders a count on the first paint.
A tally therefore **survives a renewal** (same CID) and **not an edit** (new bytes, new CID, empty
tally), which is correct: a tally belongs to the words people read.

⚠️ **`index` on `ForumThread`/`UserPost`/`Reply` is a POSITION in the loaded page, not an id.** It
changes when someone else posts. Anything that must outlive that — a vote key, a deep link — uses
`cid`.

## Registry ids live in ONE file: `lib/registry.ts`

`openRegistryId(name)`, `FORUM_REGISTRY`, `FEED_REGISTRY` and `threadRegistryId(cid)` are all there,
and `useForumThread` / `useUserPosts` re-export the two constants so old importers still work. A
registry id computed in two places is one that will eventually disagree with itself, and the failure
is silent: writes land in a chain nobody reads.

**A thread's replies are their own registry** — `keccak256("thread:" + parentCid)`. Three properties
that made this the shape rather than a parent field:

- it is an **open** id, so it can never be claimed and nobody can moderate somebody else's replies;
- it is keyed on the **CID**, so the conversation survives everybody else posting;
- there is **nothing to deploy and nothing to claim** — the registry exists the moment someone writes
  into it.

`threadRegistryId` returns **null** for an absent CID rather than hashing the bare prefix, for the
same reason `entityIdOfCid` does: one shared id would silently merge every unresolved parent's
replies into one conversation.

⛔ **REPLIES ARE FLAT, AND THAT IS NOT A TODO.** The wire format gives a `post` exactly one link —
`prev`, its place in a chain — and no parent pointer, so `parentReplyIndex`/`depth`/`children` are
not representable. The nesting fields are gone from `Reply`, and the reply-to-a-reply button and
depth-driven indentation were **removed** rather than left to throw. Do not re-add a parent field to
the wire format to bring them back; the shape that would actually work is a nested registry
(`thread:<replyCid>`), which `threadRegistryId` already supports for free — it is a product decision,
not a missing function.

## Publishing: `lib/publish.ts` + `usePublisher`

**Every write in Plaza takes two signatures**: the body goes to Bulletin (`putBlob`, host-signed) and
the pointer goes to `PostRegistry` (`setHead`). One place owns that, and nothing else should know it.

The split between the two files is not tidiness. `lib/publish.ts` takes its chain access as
**injected functions** — `readHead`, `writeHead`, `putBlob` — so that the ordering invariants have
tests, because this path only runs inside a container, i.e. on a phone, where every bug costs a
deploy to see. `hooks/usePublisher.tsx` is the ethers/ABI half.

| Rule | Why |
|---|---|
| **Body first, pointer second. Always.** | A failed pointer write orphans a body, which expires harmlessly. The other order moves a head to a CID no gateway can serve — a permanent hole every later reader walks into. |
| **`store()` seeds the blob cache with the exact bytes.** | A fresh CID takes MINUTES to reach public gateways. Without it a user's own post reads as "(content no longer available)" for its first few minutes. |
| **`publish()` polls until the read RPC sees the new head**, and returns `confirmed: false` rather than claiming success. | The host settles at best-block; we read through a separate RPC that trails it. Events cannot substitute — `eth_getLogs` cannot see host-submitted calls. |
| **`storeBlock` is `0`.** | It is the Bulletin block of the store extrinsic, and the preimage channel returns no block receipt. A fabricated number would produce a confidently wrong expiry countdown; 0 produces none, which is true. |
| **`usePublisher()` returning `null` means "cannot write"** — gate composers on it, not on `signer`. | `signer` is the DELEGATE arm and is null on a perfectly writable session. Gating on it hid the composer from everyone who could actually post. |

**The pointer is host-signed (`setHead`), so posting prompts once per post.** That is correct for now:
the delegate is unauthorised and unfunded, and sending from it produced `code 1012`. When
`authorizeDelegate` lands, the branch goes in `usePublisher`'s `writeHead` — `setHeadFor(author, …)`
— and nothing else changes, because the contract credits the WRITER, never the signing key.

⚠️ **Timestamps are epoch MILLISECONDS throughout the migrated layer** — `lib/wire.ts` stores `t` in
ms, and `HeadRef.movedAt` (SECONDS on chain) is converted at the hook boundary. `formatTimestamp`
takes ms and no longer multiplies by 1000; only the un-migrated **chat** path still converts visibly
at the call site. The old mismatch was only caught because it was absurd: the first real thread
rendered as **58548-06-08**.

**A thread is not a post with a title.** Creating one stores TWO objects: the opening `post` (the
body), then a `thread` announcement carrying title/tags/excerpt and pointing at the post's `opCid`.
That indirection is what makes cross-posting possible, and it is why the excerpt rides on the
announcement — a board renders from one chain walk, and a thread whose body expired still shows what
it was.

## Errors: `lib/errors.ts` + `reportError`

**Every catch block should call `reportError('what the user was doing', err)`**, not
`toast.error('Failed to X')`. A toast is the right SIZE for an error and the wrong PLACE for its
detail; `Failed to create thread` was the end of the trail, with the real cause only in a console
nobody can open on a phone. The paradigm:

1. **Short toast** — one recognisable line, never a stack trace.
2. **Tap the toast to copy** the full text — cause chain, contract, selector. Someone who cannot read
   a stack trace can still paste one.
3. **Settings → RECENT ERRORS** — durable, newest first, COPY button, text selectable in case the
   clipboard is blocked. The error you need is always the one you just dismissed.

`summarise()` also interprets: a `require(false)` with no data is reported as *"the contract rejected
this call, or does not have this function at that address"*, because the raw text implies the opposite
and the second reading has been correct every time so far.

## The header status control (`SessionStatus`)

Shows **`! ERROR`** and nothing else — only when inside the host with something broken, or when reads
fail. In a plain browser tab it renders **nothing**: reading is the intended experience there and a
status chip would label a normal situation as a deficiency. The composer carries the explanation
instead. It must never flash during `isInitializing`, when `canWrite` is briefly false for everyone.

⚠️ There is no "connect" control and must not be. See `SessionStatus.tsx`.

## Key Components

| Component | Purpose |
|-----------|---------|
| `App.tsx` | Main component, wallet orchestration, view routing |
| `Sidebar.tsx` | Forum/Following navigation. The Channels section is **gone** |
| `ChatFeed.tsx` | Message display — ⛔ parked, zero importers |
| `MessageInput.tsx` | Message composition — ⛔ parked, zero importers |
| `UserProfileModal.tsx` | Inline profile overlay |
| `ProfileView.tsx` | Full profile view (from Following) |
| `UserAddress/UserLink` | Clickable user profile opener (hover: tooltip, click: profile) |
| `UserAddress/AddressDisplay` | Informational address with copy-on-click |

## Host container integration (`src/lib/host/`)

**There are no wallet modes.** The MetaMask path and the standalone in-app wallet are deleted
(`docs/products-platform/architecture.md` §1: the host container is the only surface). What replaced
them is one seam — see `src/lib/host/index.ts` for the full interface, and read it before touching
any of this.

| Concept | Where | The rule that must not be broken |
|---|---|---|
| Capabilities | `capabilities.ts` | `canWrite` and `canPushLive` are SEPARATE. `canWrite && !canPushLive` is the common case. **Never gate the composer on `canPushLive`.** |
| Allowance | `allowance.ts` | Requested at the first WRITE, never on load, never on a read path. Latch caches the ATTEMPT, not the answer. `AutoSigning` is never requested. |
| Signer seam | `types.ts` (`SignerSeam`) | Arm 1 host-signed, prompts every time. Arm 2 delegate-signed, prompt-free. Arm 1 is NOT an `ethers.Signer` and cannot be. |
| Host contract writes | `contracts.ts` (`HostBackend.writeContract`) | **Owner-only calls MUST use this.** The delegate would be recorded as `msg.sender` AND is unfunded — that combination produced `code 1012 "Transaction is temporarily banned"`. |
| Bulletin writes | `session.ts` `putBlob` | Try CloudStorage, **fall back to the host preimage channel**. On an `rpc-gateway`-mode host the fallback is the only path that works. Returns a locally computed CID, since the preimage channel returns a hex key. |
| Read-after-write | anywhere calling `writeContract` | **Poll the view function.** The host settles at best-block but we read via a separate RPC that trails it, so one immediate read returns the OLD state. Events cannot help: `eth_getLogs` cannot see host-submitted calls. |
| Delegate key | `delegate.ts` | Derived via `deriveEntropy` (RFC-0007). Never `Wallet.createRandom()`, never written to disk. |
| Fake backend | `fake.ts`, `backend.ts` | Required infrastructure — the SDK throws outside a container. `?backend=fake&caps=write` is the scenario that matters most. Its `writeContract` **refuses rather than being null**: null would remove the publisher and silently un-render the composer that scenario exists to test, and a stub that "succeeded" would be followed by a read of the REAL chain that never shows the write. |
| SDK imports | `sdk.ts` | The ONLY module importing `@parity/*`. Keep it that way. |

Fake-backend scenarios are listed in `FAKE_SCENARIOS` and rendered by the settings screen in dev.

**Vite `base` must stay `'./'`** — the bundle is served from a Bulletin CID path inside a sandboxed
iframe, so absolute asset URLs 404 with no reachable console.

## Detailed Documentation

See `docs/` for in-depth documentation:
- `docs/architecture.md` - Hook patterns, state flow, common pitfalls
- `docs/user-flow.md` - User flows, wallet flows, troubleshooting
- `docs/STYLE_GUIDE.md` - UI styling patterns and components
