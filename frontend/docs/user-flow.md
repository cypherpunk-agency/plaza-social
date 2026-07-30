# User Flows

**Rewritten 2026-07-30.** The previous version was 552 lines describing a product that no longer
exists — actively misleading rather than merely out of date. Deleted wholesale:

| Removed | Why |
|---|---|
| Flow 1–4: session account, browser wallet, linking them | **There are no wallet modes.** The Polkadot host container is the only surface; MetaMask and the standalone in-app wallet are deleted code. |
| Flow 5: Disconnect and Reconnect | The host owns the account. A product cannot log it out, so there is no disconnect — the settings screen deliberately offers none. |
| Flow 7: Export Private Key | Must never exist for the delegate key: it is derived per-device via `deriveEntropy` and never written to disk. |
| Flow 8–10: creating channels, permissions, posting mode | `ChannelRegistry` / `ChatChannel` are deleted contracts. A room is now a `bytes32` registry id inside the one `PostRegistry`. |
| DM Requirements | Encrypted DMs are dropped entirely — the platform offers no 1:1 primitive. `sessionPublicKeys` and the ECDH layer went with them. |
| Wallet Mode States | See above. |

Short by design. Where a flow is not migrated this says so rather than describing an intention.
Background: [`STATUS.md`](../../docs/products-platform/STATUS.md),
[`gotchas.md`](../../docs/products-platform/gotchas.md).

---

## Flow 0 — Anonymous reading. Works everywhere, needs nothing.

Reads never touch the host: plain `eth_call`s against the Asset Hub RPC plus Bulletin object fetches
over public gateways. They work in an ordinary browser tab, outside any container, with no account.
**Verified 2026-07-30** against the live contracts.

1. `useDeployments` fetches `deployments.json` and resolves the `products-devnet` entry.
2. `useForumThread` reads `PostRegistry.getHeadsPaged(FORUM_REGISTRY, 0, 50)` — one head per writer,
   newest-first — then `walkChain` follows each chain backwards through Bulletin via `blob-cache`,
   tolerating holes where a body has expired.
3. The header shows `◐ READ-ONLY`; tapping it explains that posting needs the Polkadot app.

**Lean on this flow when debugging.** If reading is broken the fault is addresses or the data layer,
not the host.

## Flow 1 — Opening Plaza inside the Polkadot app

There is **no connect step**. The host derives a product account and hands it over, or it does not.

1. The host asks for *"Sign and submit on-chain transactions"* (`ChainSubmit`) — the one unavoidable
   dialog on a first visit.
2. `SignerManager.connect()` returns the account; Plaza prefers the host's own selection if it has one.
3. Plaza requests `PreimageSubmit`, needed by the fallback write path below. Non-fatal.
4. A **delegate key** is derived locally via `deriveEntropy` (RFC-0007). One authorising prompt per
   90 days, not one per post. It can never write Bulletin — contract calls only.
5. Resource allocation is **deferred to the first write**, never requested on load, so a reader never
   sees that dialog.

If any step fails, the header shows a status button and the panel behind it names the failing step.
DIAGNOSTICS reports every step unabridged — it is the only debugger available on a phone.

## Flow 2 — Posting. Two signatures, and a fallback that matters.

A post is two writes: the **body** to Bulletin, then a **head pointer** to `PostRegistry`.

1. `putBlob(bytes)` computes the CID locally — Bulletin is content-addressed, so this needs no chain.
2. It tries `CloudStorageClient.store().send()` (account-authorized).
3. **If that throws, it falls back to the host preimage channel** — and on a real device that is the
   path that works. A host in `rpc-gateway` chain-backend mode answers `featureSupported({Chain})` from
   a three-element list (relay, Asset Hub, People) that never contains a Bulletin chain, so the
   CloudStorage route fails with `ChainNotSupportedError` for *every* Bulletin genesis. Verified on a
   phone 2026-07-30. The preimage channel goes through the TruAPI bridge, touches no chain client, and
   is unaffected.
4. The head pointer is written by the delegate key, prompt-free, naming its principal (`setHeadFor`).

⚠️ **The preimage path returns a hex preimage key, not a CID, and yields no `(block, index)` receipt.**
Bulletin `renew` is positional, so content written this way is the hardest to keep alive past
retention. Expect a per-write "Submit Preimage" dialog — measured as unconditional; no grant
suppresses it.

## Flow 3 — Profiles

`UserRegistry` is deployed and **reads work today** — display names resolve. Creating or editing a
profile is owner-only and needs a host-signed contract write. `SignerSeam.host.submit` now exists but
has no caller, so **creating a profile does not work yet**; the banner is honest about doing nothing
rather than failing silently.

## Flow 4 — Viewing a thread, a post, a profile

Deep links still work by list POSITION (`?thread=3`). That is a known weakness: there is no stable
on-chain index any more, only CIDs, so a position shifts when someone else posts. These should move to
`?cid=` when the detail views are migrated.

## Not migrated — do not describe these as working

- **Chat / channels — REMOVED FROM THE UI (2026-07-30), code parked.** There is no Channels section,
  no channels view, and no "+ New Channel". `ViewMode` has no `'channels'` member, so a stale
  `localStorage` value or a `?channel=0x…` link falls back to the forum instead of a blank screen.
  The eight modules (`useChannel`, `useChannelRegistry`, `ChatFeed`, `MessageInput`, `ChannelHeader`,
  `ChannelModerationModal`, `UserListPanel`, `CreateChannelModal`) are still on disk with zero
  importers, waiting for the migration. Note that creating a room is not a deployment any more: an
  open room is `keccak256(name)`, a moderated one is `PostRegistry.claimRegistry(salt, policy)`.
- **Replies, user posts, voting.** Same shape — old per-instance ABIs against deleted contracts, or
  (for `Voting`) simply not repointed at the deployed address yet.

## Troubleshooting

1. **Read DIAGNOSTICS first.** Every step reports `ok` / `skip` / `fail` with full detail.
2. **"contract not deployed" anywhere** is almost certainly address plumbing, not deployment. A wrong
   network key in `deployments.json` silently made every address `undefined` and made every view render
   that message for the whole migration.
3. **Posting off while signed in** — read the Bulletin line. Two different failures live there: no
   chain support (expected on `rpc-gateway` hosts; the preimage fallback should cover it) versus no
   authorization.
4. **Local development** — `?backend=fake&caps=write`. The SDK throws outside a container, so the fake
   backend is required infrastructure. `caps=read` exercises the read-only UI.
