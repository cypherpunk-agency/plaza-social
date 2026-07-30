# PGAS storage deposits, and who may renew Bulletin content

Two chain-level questions, settled read-only against the live Polkadot Products Devnet on
**2026-07-29**. Both answers came out **against** the pessimistic assumption we were designing around.

| | Question | Answer |
|---|---|---|
| **Q2** | Can a third party renew someone else's Bulletin content? | **YES.** No storer check exists — the pallet does not record who stored anything. The caller's own quota is charged. The donation screen is buildable. |
| **Q1** | Are `pallet-revive` storage deposits payable from PGAS, or native PAS only? | **PGAS works.** 21 live storage deposits on Asset Hub are held in PGAS right now. 128 accounts with *literally zero* native balance can allocate fresh contract storage. |

Everything below carries its method, endpoint, raw evidence and date. Claims are tagged
**VERIFIED** (I observed it), **INFERENCE** (derived, stated with its basis), or **UNKNOWN**.

---

## 0. Provenance and how to re-run everything

### Endpoints (they are disjoint — `eth_*` only works on the second, `state_*`/`chain_*` only on the first)

| Purpose | Endpoint | Observed at |
|---|---|---|
| Asset Hub, Substrate JSON-RPC over HTTP | `https://asset-hub-paseo-rpc.n.dwellir.com` | head **11578238**, `0xed5a4a1bda83f00c0a2c2fbff494190a7d1af417f8a901b633243830f5a5efbe`, 2026-07-29T21:42Z |
| Asset Hub, Ethereum JSON-RPC | `https://paseo-assethub-rpc.laissez-faire.trade` | `eth_chainId` = `0x190f1b41` (420420417), `eth_blockNumber` = 11577918 |
| Bulletin chain | `wss://bulletin-paseo.tservices.es:8443` | head **286259**, `specName` `bulletin-paseo`, `specVersion` **2003001** |

Asset Hub `specName` `asset-hub-paseo`, `specVersion` **2004002**.

### Method

`state_getMetadata` (and `state_call('Metadata_metadata_at_version', 16)` on Asset Hub) decoded with
`@polkadot-api/substrate-bindings` (`decAnyMetadata`, `unifyMetadata`) and
`@polkadot-api/metadata-builders` (`getLookupFn`, `getDynamicBuilder`). Both are already present in
`D:\Code\web3\yolodot\node_modules\.pnpm\` and import by absolute `file://` URL with **no install
step**. State read via `state_getStorage` / `state_getKeysPaged` / `state_queryStorageAt` with keys
from `buildStorage(...).keys.enc()`. Dry-runs via `state_call('ReviveApi_call', ...)` with args
encoded by `buildRuntimeCall('ReviveApi','call')`.

**Nothing was signed or submitted.** No keys, no mnemonics, no transactions, no installs. Every
probe is a read (`state_*`, `chain_*`, `eth_getLogs`, `eth_getCode`) or a `state_call` dry-run, which
executes against a block's state and discards the result.

Scratch scripts live in
`C:\Users\tommi\AppData\Local\Temp\claude\bulletin-probe\` (outside any git repository). The shared
preamble every script imports:

```js
// lib.mjs
const SB = 'file:///D:/Code/web3/yolodot/node_modules/.pnpm/@polkadot-api+substrate-bindings@0.20.3/node_modules/@polkadot-api/substrate-bindings/dist/index.js';
const MB = 'file:///D:/Code/web3/yolodot/node_modules/.pnpm/@polkadot-api+metadata-builders@0.14.3/node_modules/@polkadot-api/metadata-builders/dist/index.js';
const UT = 'file:///D:/Code/web3/yolodot/node_modules/.pnpm/@polkadot-api+utils@0.4.0/node_modules/@polkadot-api/utils/dist/index.js';
export const sb = await import(SB);
export const mb = await import(MB);
export const ut = await import(UT);
export const fromHex = ut.fromHex, toHex = ut.toHex;

export async function httpRpc(url, method, params = []) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// Minimal WS JSON-RPC client — Node 22 has a global WebSocket, no ws package needed.
export function wsClient(url) {
  const ws = new WebSocket(url); let id = 0; const pending = new Map();
  const ready = new Promise((res, rej) => { ws.addEventListener('open', () => res());
    ws.addEventListener('error', (e) => rej(new Error('ws error'))); });
  ws.addEventListener('message', (ev) => { const j = JSON.parse(ev.data); const p = pending.get(j.id);
    if (!p) return; pending.delete(j.id); j.error ? p.reject(new Error(JSON.stringify(j.error))) : p.resolve(j.result); });
  return { ready, close: () => ws.close(),
    call: (method, params = []) => ready.then(() => new Promise((resolve, reject) => {
      const my = ++id; pending.set(my, { resolve, reject });
      ws.send(JSON.stringify({ id: my, jsonrpc: '2.0', method, params }));
      setTimeout(() => { if (pending.has(my)) { pending.delete(my); reject(new Error(method + ' timeout')); } }, 60000);
    })) };
}

export async function getMeta(callFn) {
  const raw = fromHex(await callFn('state_getMetadata', []));
  const uni = sb.unifyMetadata(sb.decAnyMetadata(raw).metadata);
  const lookup = mb.getLookupFn(uni);
  return { uni, lookup, builder: mb.getDynamicBuilder(lookup) };
}
```

### One gotcha worth knowing

`getLookupFn` from `@polkadot-api/metadata-builders` **drops variant doc strings**. If you dump
calls/events/errors through it you will conclude the pallet has no documentation. It does. Read the
decoded v14 registry directly instead — every doc string quoted in this document was extracted that
way, from the chain, not from a repository:

```js
// 08-call-docs-from-chain.mjs  (works on either chain)
import { wsClient, fromHex, sb } from './lib.mjs';
const c = wsClient('wss://bulletin-paseo.tservices.es:8443');
const dec = sb.decAnyMetadata(fromHex(await c.call('state_getMetadata', [])));
const m = dec.metadata.value;                              // v14 body
const types = new Map(m.lookup.map((t) => [t.id, t]));
const p = m.pallets.find((x) => x.name === 'TransactionStorage');
const variants = types.get(p.calls.type ?? p.calls).def.value.value ?? types.get(p.calls.type ?? p.calls).def.value;
for (const v of variants) {
  console.log(`\n---- [${v.index}] ${v.name} ----`);
  console.log('args: ' + v.fields.map((f) => `${f.name}: ${f.typeName}`).join(', '));
  for (const d of v.docs) console.log('  /// ' + d);
}
c.close();
```

---

# Q2 — Third-party renewal of Bulletin content

## 2a. Does `renew` require the origin to be the original storer?

### **NO. VERIFIED.**

Quoted from the on-chain metadata at `wss://bulletin-paseo.tservices.es:8443`, 2026-07-29
(`TransactionStorage`, pallet index 40, call index 1):

> ```
> /// Schedule a **one-shot** auto-renewal of previously stored data. The renewal fires
> /// exactly once, when the data reaches its `RetentionPeriod` boundary, and then the
> /// registration is removed. For continuous renewal, use
> /// [`enable_auto_renew`](Self::enable_auto_renew) instead.
> ///
> /// `entry` identifies the data either by `(block, index)` or by content hash.
> ///
> /// Feeless. Registration cost (one transaction unit) is charged in `check_signed`;
> /// the eventual renewal cycle charges bytes against `bytes_permanent` and the
> /// chain-wide cap.
> ///
> /// Rejects with [`AutoRenewalAlreadyEnabled`](Error::AutoRenewalAlreadyEnabled) if a
> /// scheduled renewal already exists for this content hash.
> ///
> /// Emits [`RenewalEnabled`](Event::RenewalEnabled) `{ recurring: false }`.
> ///
> /// For synchronous renewal at dispatch time, see [`force_renew`](Self::force_renew).
> ```

`force_renew` (call index 2):

> ```
> /// Immediately renew previously stored data, synchronous at dispatch time.
> ///
> /// Authorization is required (as with [`store`](Self::store)). Charges `info.size`
> /// against `bytes_permanent` (per-account renew cap) and `PermanentStorageUsed`
> /// (chain-wide cap).
> ///
> /// Emits [`Renewed`](Event::Renewed) when successful.
> ```

`enable_auto_renew` (call index 12):

> ```
> /// Enable automatic renewal for a previously stored piece of data.
> ///
> /// **Recurring scheduler with pre-paid first cycle.** The extension's
> /// `check_signed` charges `bytes_permanent`, `PermanentStorageUsed`, and
> /// one tx slot at registration (same hard-cap accounting as `force_renew`
> /// / one-shot `renew`). ... From that point on, every subsequent cycle charges
> /// the owner's authorization in `do_process_auto_renewals`,
> /// dropping the registration with [`Event::AutoRenewalFailed`] if the
> /// quota is exhausted at cycle time.
> ///
> /// Feeless: no token fee. Spam is bounded structurally by the up-front
> /// hard-cap charge — the caller cannot over-schedule past their
> /// `bytes_allowance` or the chain-wide `MaxPermanentStorageSize`.
> ```

**Not one of the three doc strings mentions a storer, an author, or an owner of the content.** The
only ownership language anywhere in the pallet is on `disable_auto_renew`, and it is ownership of the
*renewal registration*, not of the content:

> ```
> /// Disable automatic renewal for a piece of data.
> ///
> /// Signed: the caller must be the account that originally enabled the renewal,
> /// and the registration must not be in its prepaid window ...
> ```

### Three independent confirmations

**(i) The pallet has nowhere to put a storer identity. VERIFIED.** The per-entry record decoded from
`TransactionStorage.Transactions` is:

```
{ chunk_root: [u8;32], content_hash: [u8;32], hashing: Enum{Blake2b256|Sha2_256|Keccak256},
  cid_codec: u64, size: u32, extrinsic_index: u32, block_chunks: u32, kind: Enum{Store|Renew} }
```

No account field. A storer check is structurally impossible without walking historical extrinsic
bodies, which a runtime cannot do.

**(ii) No error variant for it. VERIFIED.** The full error list (24 variants) contains
`RenewedNotFound` ("Renewed extrinsic is not found."), `AuthorizationNotFound`,
`PermanentAllowanceExceeded`, `ChainPermanentCapReached`, and `NotAutoRenewalOwner` ("Caller is not
the owner of the auto-renewal registration."). **There is no `NotStorer` / `NotContentOwner`
variant.** If renewal were storer-restricted, the rejection would need a name.

**(iii) The extrinsic bodies. VERIFIED against source whose doc strings match the deployed metadata
byte-for-byte.** Fetched read-only from
`https://raw.githubusercontent.com/paritytech/polkadot-bulletin-chain/master/pallets/transaction-storage/src/lib.rs`
(HTTP 200, 114 169 bytes, sha256 `809ed096fd738396f75bb93ad466e9819d20ed57197cc21977e8413bb0fd822d`).
Provenance chain: the file's call indices (0, 9, 1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14, 15, 16, 17),
argument types, 18 event variants and 24 error variants match the deployed metadata exactly, **and
every doc string quoted above is present verbatim in the deployed metadata blob** — confirmed by
byte-probing the raw blob:

```js
// 07-rawmeta-docs.mjs
const raw = fromHex(await c.call('state_getMetadata', []));
const txt = Buffer.from(raw).toString('latin1');
for (const p of ['Schedule a **one-shot** auto-renewal', 'Immediately renew previously stored data',
                 'Enable automatic renewal for a previously stored piece of data',
                 'the caller must be the account that originally enabled the renewal'])
  console.log(txt.indexOf(p) >= 0 ? 'PRESENT' : 'ABSENT', JSON.stringify(p));
// => PRESENT @63238 / @64121 / @68523 / @69942
```

The bodies:

```rust
pub fn renew(origin: OriginFor<T>, entry: TransactionRef<BlockNumberFor<T>>) -> DispatchResult {
    let AuthorizedCaller::Signed { who, scope: _ } = Self::ensure_authorized(origin)?
    else { return Err(DispatchError::BadOrigin); };
    let info = Self::resolve_transaction_ref(&entry)?;
    let content_hash = info.content_hash;
    ensure!(!AutoRenewals::<T>::contains_key(content_hash), Error::<T>::AutoRenewalAlreadyEnabled);
    AutoRenewals::<T>::insert(content_hash,
        RenewalData { account: who.clone(), recurring: false, paid: true });
    Self::deposit_event(Event::RenewalEnabled { content_hash, who, recurring: false });
    Ok(())
}

pub fn force_renew(origin: OriginFor<T>, entry: TransactionRef<BlockNumberFor<T>>)
    -> DispatchResultWithPostInfo {
    let _caller = Self::ensure_authorized(origin)?;      // <- caller discarded
    let info = Self::resolve_transaction_ref(&entry)?;
    Self::ensure_data_size_ok(info.size as usize)?;
    let content_hash = info.content_hash;
    let new_index = Self::do_renew(info)?;
    Self::deposit_event(Event::Renewed { index: new_index, content_hash });
    Ok(().into())
}
```

`ensure_authorized` checks only that the origin carries a *storage authorization*:

> ```
> /// - [`Origin::Authorized`] (set by [`extension::ValidateStorageCalls`]) →
> ///   [`AuthorizedCaller::Signed`]
> /// - Root → [`AuthorizedCaller::Root`]
> /// - None (unsigned) → [`AuthorizedCaller::Unsigned`]
> ///
> /// Any other origin (including plain `Signed`) returns [`DispatchError::BadOrigin`].
> ```

And the pallet ships a public predicate that spells out, exhaustively, what a renewal requires — note
that **every condition is about `who`, the caller, and none is about who stored the data**:

> ```
> /// Returns `true` iff a `renew(entry)` call would currently pass transaction
> /// validation for `who`.
> ///
> /// - `entry` resolves to currently-stored data
> /// - the stored data's size is within `[1, MaxTransactionSize]`
> /// - `who` has an unexpired authorization entry
> /// - per-account hard cap: `bytes_permanent + size <= bytes_allowance`
> /// - chain-wide hard cap: `PermanentStorageUsed + size <= MaxPermanentStorageSize`
> pub fn can_renew(who: &T::AccountId, entry: &TransactionRef<BlockNumberFor<T>>) -> bool
> ```

### Two constraints the donation screen must design around

**`renew` is a scheduler, not a renewal. VERIFIED** (doc string above). It registers a one-shot that
fires at the `RetentionPeriod` boundary. The user clicks "preserve this" and nothing observable
happens for up to 14 days. **`force_renew` is the immediate one** — synchronous at dispatch, emits
`Renewed` in the same block. For a UI with feedback, `force_renew` is the call you want.

**`renew` and `enable_auto_renew` are single-occupancy per content hash. VERIFIED** — both reject
with `AutoRenewalAlreadyEnabled` if any `AutoRenewals` entry exists for that hash, and the check runs
in `check_signed` (pool admission), so a second donor's transaction is rejected before it reaches a
block. So the *scheduled* paths are first-come-first-served: one preserver per item, and they cannot
release the slot until the first cycle fires (`CannotDisablePrepaidAutoRenewal`).
**`force_renew` has no such restriction** — any number of authorized accounts may force-renew the
same content, repeatedly. **INFERENCE (strong, from the code paths above): build the donation feature
on `force_renew`, not on `renew`.**

### The SDK does not expose this

`CloudStorageClient.renew(block: number, index: number): CallBuilder` in
`@parity/product-sdk-cloud-storage` maps to `TransactionRef::Position`. The pallet's `entry` argument
is `Enum{Position({block: u32, index: u32}) | ContentHash([u8;32])}` — **VERIFIED** from metadata —
so the `ContentHash` variant and `force_renew` entirely are unreachable through the SDK wrapper. An
app that wants either must encode the call itself. **UNKNOWN:** whether the host's signing surface
will accept an arbitrary encoded call or only SDK-constructed `CallBuilder`s.

## 2b. Whose quota does a renewal charge?

### **The caller's. VERIFIED.**

From the transaction extension's `check_signed`, where `who` is the signer:

```rust
Call::<T>::renew { entry } => {
    let info = Self::resolve_transaction_ref(entry).map_err(|_| RENEWED_NOT_FOUND)?;
    if AutoRenewals::<T>::contains_key(info.content_hash) { return Err(AUTO_RENEWAL_ALREADY_ENABLED.into()); }
    Self::check_authorization(
        &AuthorizationScope::Account(who.clone()),   // <- the caller
        info.size, context.consume_authorization(), true)?;
    ...
}
Call::<T>::enable_auto_renew { content_hash } => {
    ...
    Self::check_authorization(&AuthorizationScope::Account(who.clone()), info.size, ..., true)?;
}
```

Corroborated by the `PermanentAllowanceExceeded` error doc, quoted from the chain:

> ```
> /// Renew rejected: would push the signer's `bytes_permanent` past their
> /// `bytes_allowance` (per-account hard cap).
> ```

— *the signer's*, not the storer's.

Three details that matter for budgeting:

1. **`force_renew` (and `store`) prefer a preimage authorization if one exists**, and only fall back
   to the caller's account quota. From the shared tail of `check_signed`:

   ```rust
   // Prefer preimage authorization if available.
   // This allows anyone to store/renew pre-authorized content without consuming their
   // own account authorization.
   let used_preimage_auth = Self::check_authorization(
       &AuthorizationScope::Preimage(content_hash), size as u32, consume, is_renew).is_ok();
   if !used_preimage_auth {
       Self::check_authorization(&AuthorizationScope::Account(who.clone()), size as u32, consume, is_renew)?;
   }
   ```

   **VERIFIED that this path is dormant today:** all 255 authorizations on the chain are
   `Account`-scoped, zero are `Preimage`-scoped (§2d). So in practice `force_renew` charges the
   caller. **INFERENCE:** an operator who wanted to fund renewals centrally could do it by granting
   preimage authorizations per content hash, letting *any* account renew that item at zero cost to
   itself. That is a genuinely different funding model and worth asking the Products team about.

2. **Recurring auto-renew cycles charge the registrant, not the storer either.** `do_process_auto_renewals`
   uses `AuthorizationScope::Account(renewal_data.account.clone())`, and `renewal_data.account` was
   set to `who` — the caller of `renew`/`enable_auto_renew`.

3. **Renewal is a hard cap where `store` is a soft one. VERIFIED** from the two doc strings:
   `can_store` — *"`store` saturates against `bytes` / `transactions` and uses the priority boost
   (soft limit), so no per-account or chain-wide hard cap applies here"*; `can_renew` — the two hard
   caps quoted above. **Writing is effectively unmetered; keeping what you wrote is metered.** A
   donor's `bytes_allowance` (modally 4 MiB, §2d) is the real budget for how much of other people's
   content they can preserve — and `bytes_permanent` accumulates across renewals without resetting
   until the authorization itself rolls over.

## 2c. What identifies the content — is `(block, index)` recoverable from a CID?

### **Yes, entirely. No schema change needed. VERIFIED, two ways.**

**First: you do not need `(block, index)` at all.** The pallet's `entry` argument accepts a content
hash directly, and resolves it itself:

```rust
fn resolve_transaction_ref(entry: &TransactionRef<BlockNumberFor<T>>) -> Result<TransactionInfo, Error<T>> {
    let (block, index) = match entry {
        TransactionRef::Position { block, index } => (*block, *index),
        TransactionRef::ContentHash(hash) =>
            TransactionByContentHash::<T>::get(hash).ok_or(Error::<T>::RenewedNotFound)?,
    };
    Self::transaction_info(block, index).ok_or(Error::<T>::RenewedNotFound)
}
```

**Second: even the positional form is recoverable**, because the chain maintains the index for you.
Storage item doc, quoted from the chain:

> ```
> ///  Maps content hash to its most recent (block_number, tx_index) location.
> pub(super) type TransactionByContentHash<T: Config> =
>     StorageMap<_, Blake2_128Concat, ContentHash, (BlockNumberFor<T>, u32)>;
> ```

Measured over the entire live corpus: **5 659 / 5 659 content hashes resolve to a `(block, index)`
whose stored entry's `content_hash` equals the key. Zero mismatches, zero missing blocks.**

```
# head 286259 2026-07-29T21:23:39Z
=== TransactionByContentHash (full) ===   live content hashes: 5659
=== Transactions (full, keyed by block) === blocks with entries: 4194
total entries: 9551   kinds: {"Store":9551,"Renew":0}   total bytes: 1332242754
=== round-trip: TransactionByContentHash -> Transactions[block][index] ===
resolved OK: 5659   mismatched: 0   block absent: 0   (of 5659)
```

**And CID → content hash is a pure client-side transform**, so an app holding only a CID string can
do all of this with no recorded state. `content_hash` is the multihash digest inside the CID; the
codec and hash function live in the chain's own `TransactionInfo`. Verified by reconstructing CIDs
from chain state and fetching them from a public gateway:

```
hash=0xce085206edfae15f...c0a4  (block,index)=(265320,9)  size=5900   codec=85  Sha2_256
  reconstructed CID: bafkreigobbjan3p24fpvlz4ietvmarea24lj5klhkxlpytsxmqwfmqoauq
  gateway: HTTP 200 bytes=5900 matches chain size: true
hash=0x586eaacb3e0a7612...3234  (block,index)=(104728,0)  size=140358 codec=85  Sha2_256
  reconstructed CID: bafkreicyn2vmwpqkoyjmbyqhvrocv7gfugnbbfqo46bxbu46zgvcyobsgq
  gateway: HTTP 200 bytes=140358 matches chain size: true
hash=0x6cf5723b98bd8046...1ff3  (block,index)=(271754,0)  size=430    codec=85  Blake2b256
  reconstructed CID: bafk2bzacebwpk4r3tc6yarxk2ezlvsefwi4cbxkglukgzzevs2bcvzawemp7g
  gateway: HTTP 200 bytes=430 matches chain size: true
hash=0x6516d1afa65adfec...ab16  (block,index)=(271842,0)  size=58     codec=112 Sha2_256
  reconstructed CID: bafybeidfc3i27js237wkpmdg76iwh2wftj2r3i2crwqwtvpcohxj5pflcy
  gateway: HTTP 200 bytes=30817 (dag-pb root; unwrapped by gateway, so size differs by design)
```

6/6 resolved. Codec 85 = `raw`, 112 = `dag-pb`; hashing is per-entry, so both `Sha2_256` and
`Blake2b256` occur and the client must read `hashing` from the chain rather than assume.

```js
// 10-cid-roundtrip.mjs — CIDv1 = <0x01><codec varint><hash-fn varint><len varint><digest>
const MH = { Sha2_256: 0x12, Blake2b256: 0xb220, Keccak256: 0x1b };
const varint = (n) => { const o = []; while (n >= 0x80) { o.push((n & 0x7f) | 0x80); n >>>= 7; } o.push(n); return o; };
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32lower(b) { let bits = 0, v = 0, out = '';
  for (const x of b) { v = (v << 8) | x; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(v << (5 - bits)) & 31]; return out; }
const toCidV1 = (hashHex, codec, hashing) => 'b' + base32lower(Uint8Array.from(
  [0x01, ...varint(Number(codec)), ...varint(MH[hashing]), 32, ...fromHex(hashHex)]));
```

### The one schema consequence that *is* real

**`TransactionByContentHash[hash]` is removed the moment the content expires. VERIFIED** from
`on_initialize`:

```rust
let obsolete = n.saturating_sub(period.saturating_add(One::one()));
if let Some(transactions) = <Transactions<T>>::take(obsolete) {
    for tx_info in transactions.into_iter() {
        let hash: ContentHash = tx_info.content_hash;
        let is_latest = TransactionByContentHash::<T>::get(hash).is_some_and(|(block, _)| block == obsolete);
        if !is_latest { continue; }                       // a later renew moved it; that entry's own expiry handles it
        TransactionByContentHash::<T>::remove(hash);
        ...
```

So the chain will tell you *where* a CID lives and *when it dies*, but only while it is alive. After
expiry, `renew`/`force_renew` return `RenewedNotFound` and the doc is explicit that recovery means
re-`store`ing the original bytes:

> ```
> /// On failure the data is **gone**: the same `on_initialize` that queued the
> /// pending renewal already `take`-d the obsolete `Transactions` entry and cleared
> /// [`TransactionByContentHash`]. The caller cannot re-`enable_auto_renew` because
> /// the content hash no longer resolves to a stored entry — to keep the data alive
> /// they must re-`store` it first.
> ```

**Recommendation (INFERENCE):** you do not need to record `(block, index)`. You *do* need the CID,
and you need to surface expiry early enough to act. Derive the whole "nearing expiry" list from chain
state at read time:

```
expires_at = TransactionByContentHash[content_hash].block + RetentionPeriod
```

That is one map read per item and needs no app-side bookkeeping at all. Retaining the original bytes
(or a re-fetchable copy) is the only durable insurance, since a missed renewal is unrecoverable
on-chain.

## 2d. The authorization grants in practice

**VERIFIED**, 2026-07-29, head 286197, from a full enumeration of `TransactionStorage.Authorizations`:

```
count: 255      scope: Account = 255      Preimage = 0
```

Distribution of `(transactions_allowance, bytes_allowance)`:

| Grant (`transactions_allowance` / `bytes_allowance`) | Accounts | Share |
|---|---|---|
| `10 tx / 4 MiB` | **155** | **60.8 %** |
| `1000 tx / 100 MB` | 33 | 12.9 % |
| `100 tx / 10 MiB` | 16 | 6.3 % |
| `20 tx / 8 MiB` | 8 | 3.1 % |
| `1000 tx / 100 MiB` | 5 | 2.0 % |
| `10000 tx / 1000 MB` | 4 | 1.6 % |
| long tail: `25/8 MiB` ×2, `200/20 MiB` ×2, `200/128 MiB` ×2, and 28 singletons from `1 tx / 10 B` up to `1 501 000 tx / 11.5 GiB` | 34 | 13.3 % |

Raw sample:

```
[{"type":"Account","value":"5FZVJi9dFnyywGrsoKqjZA65qdXByBT3YktS4PJE1QYpQuVY"}] =>
  {"extent":{"transactions":1,"transactions_allowance":10,"bytes":"326",
             "bytes_permanent":"0","bytes_allowance":"4194304"},"expiration":430443}
[{"type":"Account","value":"5GmrGRR2a1q6PLdApBfYWCssNqkaYdnfo8jvzEW3wdUsh8V5"}] =>
  {"extent":{"transactions":31,"transactions_allowance":200,"bytes":"6585614",
             "bytes_permanent":"0","bytes_allowance":"20971520"},"expiration":399482}
```

`bytes_permanent == 0` on **every one of the 255 authorizations** — the renewal counter has never
been touched by anyone.

**`AuthorizationPeriod` really does equal `RetentionPeriod`. VERIFIED, two ways.**

```
AuthorizationPeriod   raw=0x80130300  (LE u32)  = 201600     [constant]
RetentionPeriod       raw=0x80130300            = 201600     [storage, read via state_getStorage]
```

Cross-checked against the live expiration spread: max observed `expiration` is **487 761** against
head **286 197**, i.e. `head + 201 564` — just inside `head + 201 600`. 4 of 255 authorizations have
already expired.

> An earlier internal note recorded `AuthorizationPeriod = 787`. That was a decoding artefact
> (double hex-encoding the constant's byte blob). The correct value is 201 600. Two other constants
> in that note (`MaxBlockTransactions`, `MaxTransactionSize`) were wrong for the same reason; correct
> values are 512 and 2 097 152.

Other measured constants: `MaxPermanentStorageSize` = 1 099 511 627 776 (1 TiB),
`MaxBlockTransactions` = 512, `MaxTransactionSize` = 2 097 152 (2 MiB), `ByteFee` = 10,
`EntryFee` = 1000, `PermanentStorageUsed` = unset (0). `AllowedAuthorizers` has **3** entries, all
`feeless: true`; one has `{transactions: 84000, bytes: 105774182400}`, one has an unbounded quota,
one has `{transactions: 0, bytes: 100935925760}`.

Block time measured over the last 1000 blocks: **6.552 s** → `RetentionPeriod` ≈ **15.3 days**. (An
earlier measurement over a different window gave 6.03 s → 14.07 days, and the official docs say
"~2 weeks by default", so treat retention as **14–15 days and drifting with collator health** rather
than a fixed number. **Compute expiry in blocks, display it in days.**)

**Nothing has ever been renewed, and expiry is now live. VERIFIED:**

```
total entries: 9551   kinds: {"Store": 9551, "Renew": 0}
AutoRenewals entries chain-wide: 0
oldest live block: 84661 -> expires at 286261 (in 2 blocks)
entries expiring within 14400 blocks (~24 h): 1389
```

The first pruning event is happening *now* (two blocks out at the time of measurement), and 1 389 of
5 659 live items — **25 % of everything on the chain** — expire within a day. A renewal feature has
an immediate, visible corpus to act on. It also means the feature is untested territory: **a
`Renew`-kind entry appearing in `Transactions` would be the first in this chain's history.**

## 2e. Is a renewal attributable on chain?

### **Yes for the scheduled paths, indirectly for `force_renew`. VERIFIED** from the event definitions.

| Event | Fields | Attributes the renewer? |
|---|---|---|
| `RenewalEnabled` | `content_hash`, **`who`**, `recurring: bool` | **Yes** — emitted by `renew` and `enable_auto_renew` at registration |
| `DataAutoRenewed` | `index`, `content_hash`, **`account`** | **Yes** — emitted when a cycle actually renews |
| `AutoRenewalFailed` | `content_hash`, **`account`** | **Yes** — emitted when a cycle fails for quota |
| `AutoRenewalDisabled` | `content_hash`, **`who`** | Yes |
| `Renewed` | `index`, `content_hash` | **No** — `force_renew` does not name the caller |

So:

- If you build on `renew` / `enable_auto_renew`, attribution is free: `RenewalEnabled.who` and
  `DataAutoRenewed.account` name the preserver, and the live registry is queryable —
  `AutoRenewals[content_hash] = { account, recurring, paid }` (**VERIFIED** storage shape, currently
  0 entries).
- If you build on `force_renew` (which §2a argues you should, for immediacy and for
  multiple-donors-per-item), the event does **not** carry the caller. You recover it from the
  extrinsic's signer in the same block — `Renewed.index` plus `TransactionInfo.extrinsic_index` point
  at the exact extrinsic. **INFERENCE (mechanically sound, not measured — there are zero renewals on
  chain to test against).**
- The persistent `Transactions` entry created by a renewal carries `kind: Renew` but **no account
  field**, so on-chain state alone will not tell you who preserved something after the fact. Credit
  has to be indexed from events/extrinsics at the time, or mirrored into your own contract.

**Practical suggestion (INFERENCE):** if crediting preservers matters, have the app write the credit
where you control it — a `PlazaHeads`-style contract call, or an event on your own contract — rather
than depending on reconstructing Bulletin extrinsic signers. Bulletin gives you the *fact* of
renewal reliably; it gives you the *actor* reliably only on the scheduled paths.

---

# Q1 — Are `pallet-revive` storage deposits payable from PGAS?

## Answer: **YES. VERIFIED, empirically, on live state.**

This reverses the assumption in `yolodot/docs/decisions/007-plaza-gossip-merge.md` §9.1. A
zero-native-balance, PGAS-holding account **can** create new contract storage.

### The decisive evidence: 21 live storage deposits are held in PGAS right now

`AssetsHolder.Holds` and `AssetsHolder.BalancesOnHold` enumerated in full,
`https://asset-hub-paseo-rpc.n.dwellir.com`, 2026-07-29:

```
AssetsHolder::Holds entries: 21    (all for asset 2000000000 = PGAS)

account                                            asset       reason                    held  nativeFree      PGAS
5DvrLEN1xCc97JDFEk9rSjtE5NAtBzpbCEgg76hzwHm2ZJTb  2000000000  StorageDepositReserve   52800000   100000000  10000000
5G7jonTh2gBa2Rtm8dzfvWgB8GAm6he478VtL5tfaj32kv7e  2000000000  StorageDepositReserve 4676830000   100000000  10000000
5Gy5mfLaLcsH54zwDTs1bNKcMLmLCADjCqNT3EnL9QXwoafT  2000000000  StorageDepositReserve  132000000   100000000  10000000
5G1jARPuZ6nL35AF1XokMgpawX6eSUw9SDBbUwsP93e8p62f  2000000000  StorageDepositReserve  158400000   100000000  10000000
5Gx53JNGP8oyRHErg5aT551mAf7fEzCUHBx6aFaiRCK4Adu4  2000000000  StorageDepositReserve  158400000   100000000  10000000
5EYCAe5ijiYfhaAUBd6H9WGRTsvwFFc7GnhQkiHvBYxdvpbV  2000000000  CodeUploadDepositReserve 4041100000 100000000    null
  ... (21 rows total; 20 StorageDepositReserve, 1 CodeUploadDepositReserve)
```

Decoded hold shape:

```json
[2000000000,"5Gy5mfLaLcsH54zwDTs1bNKcMLmLCADjCqNT3EnL9QXwoafT"] =>
  [{"id":{"type":"Revive","value":{"type":"StorageDepositReserve"}},"amount":"132000000"}]
```

Read that carefully. The **hold reason is `pallet_revive`'s own
`HoldReason::StorageDepositReserve`**, and the **asset is 2 000 000 000 = PGAS**. These are
`pallet-revive` storage deposits, denominated in PGAS, held on live accounts. Not a dry run, not a
theory.

Three corroborations:

1. **Every one of those accounts has an unusable native balance.** `nativeFree = 100 000 000` = 0.01
   PAS = exactly the existential deposit, so nothing is spendable, and `PGAS = 10 000 000` = the
   asset's `min_balance`, i.e. they spent their PGAS down to the floor.
2. **None of them appears as a contributor in `Revive::NativeDepositOf`** (checked against all 1 084
   entries). The deposit was taken **entirely** in PGAS, not split.
3. **Two of them hold exactly 158 400 000 PGAS — the exact deposit my fresh-slot `setHead` dry-run
   reports** (below). Independent arithmetic agreement.

### Confirmed by dry-run, with a perfect predictor over 250 real accounts

`state_call('ReviveApi_call', ...)` against **PlazaHeads v2** at
`0x470D0EB21Fb767CaD6511B1Ad9777A4A6bC764ae`, calling `setHead(bytes32 scope, string cid, string prev)`
with a freshly-randomised `scope` each time so the write always allocates new storage.

```
who                                                nativeFree      reserved         PGAS  prov/suff  dryrun
5FbXqt2ZdG5qGJvzmYBCKsLzGLmRxC7xV81z8nTNGoJfNvPP            0             0 800000000000  0/1  OK deposit=158400000
5EkSNdmXZcRPvmoBMkxcRhmWbdTooDGgT5uM4BsqajJc3bs5            0             0 550000000000  0/1  OK deposit=158400000
5CUxda9ANEikygbiJqNgBEB6emYaQ1bRH7D48pSZQTaLtHnF            0             0  99954806189  0/1  OK deposit=158400000
5GmiWfAQzxPoqQrXHSsdoWjrM8GS1GLMyPr3s5v571nM5khN            0             0  40422401756  0/1  OK deposit=158400000
5EyFpXybSYon74HVGUZVyvtYxTLy4EuqUxMhgXcmLM2qz1BL 10001000002982973 4018800000  10000000  1/1  OK deposit=158400000
5F5cYF6neaNpRqzsUpbo4r1xwGPaUgEwFSan7P8EnUg3pLTm    100000000    4228300000     10000000  1/1  FAIL StorageDepositNotEnoughFunds
5EiEWBbi1DHowqHKcvgsgCG15zsv9bZqok9YncpBCmqTLu5Y    100000000    3343180000     10000000  1/1  FAIL StorageDepositNotEnoughFunds
```

Accounts with **zero native balance and ample PGAS succeed**; accounts with 0.01 PAS (the ED, hence
unspendable) and only dust PGAS **fail**. Non-monotonic in native balance — which is exactly what
rules out "native-only".

Formalised over the whole PGAS-holder set. Predictor: *success ⟺ (usable native ≥ deposit) OR
(PGAS ≥ deposit)*.

```
=== confusion matrix over 250 accounts ===
predicted-OK & actual-OK    : 58
predicted-OK & actual-FAIL  : 0
predicted-FAIL & actual-OK  : 0
predicted-FAIL & actual-FAIL: 192
```

**250/250. Zero false positives, zero false negatives.** And:

```
zero native & PGAS <  deposit : 0 accounts    (no counterexample available on this chain)
zero native & PGAS >= deposit : 128 accounts  (all 8 probed: OK)
```

**128 accounts on this chain hold zero native PAS and can allocate fresh contract storage.**

The boundary is exact. Sweeping `storage_deposit_limit` on a zero-native, PGAS-funded origin:

```
limit=         0  FAIL StorageDepositLimitExhausted
limit= 158399999  FAIL StorageDepositLimitExhausted
limit= 158400000  OK   deposit=158400000
limit= 200000000  OK   deposit=158400000
```

The experiment script:

```js
// 27-experiment.mjs (abridged) — READ-ONLY, nothing signed or submitted
import { httpRpc, fromHex, toHex, sb, mb } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { keccak256 } from './keccak.mjs';              // local keccak-f1600, no deps
const RPC = 'https://asset-hub-paseo-rpc.n.dwellir.com';
const DEST = '0x470D0EB21Fb767CaD6511B1Ad9777A4A6bC764ae';
// v16 metadata carries the runtime-API signatures; v14 (state_getMetadata) does not.
const raw = new Uint8Array(readFileSync('ah-meta-v16.bin'));
const uni = sb.unifyMetadata(sb.decAnyMetadata(raw).metadata);
const rc = mb.getDynamicBuilder(mb.getLookupFn(uni)).buildRuntimeCall('ReviveApi', 'call');
// ReviveApi_call(origin: AccountId32, dest: H160, value: u128,
//                gas_limit: Option<Weight>, storage_deposit_limit: Option<u128>, input_data: Vec<u8>)
const argsHex = toHex(rc.args.enc([origin, DEST, 0n, undefined, depositLimit, abiSetHead(scope, cid, prev)]));
const r = rc.value.dec(await httpRpc(RPC, 'state_call', ['ReviveApi_call', argsHex]));
console.log(r.storage_deposit, r.gas_consumed, r.result);
```

To obtain the v16 metadata (needed because `state_getMetadata` returns v14, which has no runtime-API
section):

```js
const vs = sb.Vector(sb.u32).dec(await httpRpc(RPC, 'state_call', ['Metadata_metadata_versions', '0x']));
// => [14, 15, 16]
const raw = sb.Option(sb.Bytes()).dec(
  await httpRpc(RPC, 'state_call', ['Metadata_metadata_at_version', toHex(sb.u32.enc(16))]));
writeFileSync('ah-meta-v16.bin', raw);
```

### What it costs

Deposits scale in exact units of **26 400 000 plancks = 0.00264 PAS per new 32-byte EVM storage
slot**, which decomposes as `DepositPerChildTrieItem (20 000 000) + 64 × DepositPerByte (100 000)` —
one child-trie item plus 32 key bytes and 32 value bytes. **VERIFIED** by sweeping argument lengths:

```
FRESH scope (new writer + new scope)  cidLen=  1 prevLen=  0  deposit=105600000  (4 slots)  gas=11591
FRESH scope (new writer + new scope)  cidLen= 32 prevLen=  0  deposit=132000000  (5 slots)  gas=14281
FRESH scope (new writer + new scope)  cidLen= 59 prevLen=  0  deposit=158400000  (6 slots)  gas=16971
FRESH scope (new writer + new scope)  cidLen= 64 prevLen=  0  deposit=158400000  (6 slots)  gas=16971
FRESH scope (new writer + new scope)  cidLen= 59 prevLen= 59  deposit=237600000  (9 slots)  gas=24991
EXISTING scope, new writer            cidLen=  1 prevLen=  0  deposit= 79200000  (3 slots)  gas= 8950
EXISTING scope, new writer            cidLen= 59 prevLen=  0  deposit=132000000  (5 slots)  gas=14331
EXISTING scope, new writer            cidLen= 59 prevLen= 59  deposit=211200000  (8 slots)  gas=22351
```

Two things fall out. **Only *new* slots are charged**: writing into a scope that already has other
writers costs exactly one slot less, because `_writers[scope]`'s length slot already exists.
**INFERENCE (well-supported by that pattern, not directly measured):** a writer overwriting their own
head with a same-length CID pays ~0.

And the practical number: **a typical Plaza `setHead` with a 59-character CID into a fresh scope costs
0.01584 PAS-or-PGAS**. `PgasClaimAmount` = 50 000 000 000 = **5 PGAS per claim**, so **one claim funds
roughly 315 fresh-slot writes**, and a lite person may claim 40 times a day
(`MaxClaimsPerPeriodPerLitePerson` = 40; full = 100). Deposits are not the constraint we feared.

Revive deposit constants, read from metadata:

```
DepositPerByte             100000       (0.00001 PAS)  "The amount of balance a caller has to pay for each byte of storage."
DepositPerItem             2000000000   (0.2 PAS)      main-trie item — does NOT apply to contract slots
DepositPerChildTrieItem    20000000     (0.002 PAS)    "Those are the items created by a contract. In Solidity each
                                                        value is a single storage item."
CodeHashLockupDepositPercent 300000000
NativeToEthRatio           100000000
```

### Where the metadata *hints* at this, once you know to look

`Revive.NativeDepositOf`'s doc string is the tell. Quoted from the chain:

> ```
> ///  Native currency storage deposit contributed by a user into a contract.
> ///
> ///  Bounds how much native value the user can receive back from that contract's
> ///  storage deposit.
> ///
> ///  Keys: `(holder, contributor) -> amount`
> ///  - `holder`: account on which the deposit is held (a contract, or the pallet's own account
> ///    for code-upload deposits).
> ///  - `contributor`: user that funded the deposit. Receives the native portion on refund, capped
> ///    at this entry's `amount`.
> ```

"the **native portion** on refund" only makes sense if a deposit can have a non-native portion. The
name `NativeDepositOf` is not "the deposit ledger" — it is *the native slice* of a deposit ledger.
**This is the one place in the metadata that documents the mixed-currency design, and it is easy to
read as evidence for the opposite conclusion.**

Supporting structure, all **VERIFIED** from metadata:

- `pallet_revive::HoldReason` = `{ CodeUploadDepositReserve, StorageDepositReserve, AddressMapping }`,
  and it is a variant of the runtime-wide `asset_hub_paseo_runtime::RuntimeHoldReason` — which is the
  reason type for **both** `Balances.Holds` (native) **and** `AssetsHolder.Holds` (per-asset). One
  reason enum, two hold registries. That is the structural door through which PGAS deposits pass.
- `pallet_assets_holder::Event` = `Held/Released/Burned(AccountId, AssetId, RuntimeHoldReason, Balance)`.
- Native deposits still dominate: `Revive.NativeDepositOf` has **1 084** entries totalling
  **4 764 360 400 036 plancks = 476.44 PAS**, and `Balances.Holds` shows **3 412** accounts with
  `Revive::StorageDepositReserve` and **50** with `Revive::AddressMapping`.

### Where the metadata *misleads*, and what it does not say

`ContractInfo` gives a single scalar deposit triple with no asset dimension:

```
pallet_revive::storage::ContractInfo {
  trie_id, code_hash, storage_bytes: u32, storage_items: u32,
  storage_byte_deposit: BalanceOf<T>, storage_item_deposit: BalanceOf<T>,
  storage_base_deposit: BalanceOf<T>, immutable_data_len: u32 }
```

Reading only this, you would conclude deposits are native-only. They are not — the *amount* is
denominated once, and the *currency it is collected in* is decided elsewhere.

`PgasAllowance` (pallet index 252) has **no calls, no storage, no constants, and exactly one event**:

> ```
> /// A transaction fee `actual_fee` has been paid by `who` in PGAS and burned. Mirrors
> /// [`pallet_transaction_payment::Event::TransactionFeePaid`].
> PGASFeePaid { who: AccountId, actual_fee: BalanceOf<T> }
> ```

**Scoped strictly to transaction fees.** It says nothing about deposits — and yet deposits are
PGAS-payable. **Direct answer to the briefed question: the `AsPgas` / `PgasAllowance` doc strings are
fee-scoped only, and that scoping is *not* evidence about deposits.** The deposit behaviour lives
somewhere else entirely.

`AsPgas` (a transaction extension, `indiv_pallet_pgas::extension::AsPgas`) carries no doc string in
the metadata and its payload has a single variant:

```
AsPgas { _: Option<AsPgasInfo<T>> }
AsPgasInfo enum { [0] Claim(ProofOf<T>, RingIndex, RevisionIndex, PgasCollection, u32) }
PgasCollection enum { People, LitePeople }
```

Its only documented job is carrying the ring-VRF proof for `Pgas::claim_pgas`:

> ```
> /// Mint PGAS for a verified claim slot.
> ///
> /// Must be submitted with the [`AsPgas`] transaction extension, which
> /// verifies the ring-VRF proof and produces an [`Origin::ClaimAlias`]. The outer origin
> /// must be `None` (the extension replaces it with the local origin) ...
> ```

**This matters more than it looks. `ReviveApi_call` is a bare runtime call — no transaction
extensions run at all — and PGAS was still accepted for the deposit.** So the PGAS deposit path is
inside `pallet-revive`'s configured currency, not in any extension. **INFERENCE (strong):** the
behaviour therefore applies to plain `Revive::call` / `Revive::eth_transact` too, and does not depend
on the app attaching anything special to the transaction.

### The prerequisite nobody mentions: the account must be mapped

**VERIFIED.** An unmapped `AccountId32` origin fails immediately, `gas_consumed = 0`:

```
5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM  ->  FAIL AccountUnmapped
```

> ```
> /// An `AccountID32` account tried to interact with the pallet without having a mapping.
> /// Call [`Pallet::map_account`] in order to create a mapping for the account.
> ```

Measured: `Revive.OriginalAccount` has **4 198** entries. Of the 733 PGAS holders, **598 are
`0xEE`-padded Ethereum-native accounts** (their `AccountId32` is `H160 ++ 0xEE×12`, which needs no
mapping at all) and **135 have an explicit `OriginalAccount` mapping**.

`Balances.Holds` shows **3 502** `Revive::AddressMapping` holds, every one for exactly
**2 005 200 000 plancks = 0.20052 PAS** — **native, and roughly 12× a fresh `setHead` deposit.** No
`AddressMapping` hold appears among the 21 PGAS holds.

But the zero-native accounts that succeeded *are* mapped and have `reserved = 0` — no mapping hold at
all. The runtime sets `Revive::AutoMap = true`. **INFERENCE:** mappings can come into existence
without the 0.20052 PAS deposit (auto-mapping on first interaction), and the deposit applies to the
explicit `map_account` extrinsic. **UNKNOWN:** exactly which path a Products-app user takes, and
whether it is ever chargeable to them. **This is the residual native-balance risk in the
zero-balance story and is worth one question to the Products team.** In practice it is likely moot:
an app whose users hold `H160` accounts (the MetaMask / session-wallet shape Plaza already uses) never
needs a mapping.

### What happens when an account owing a deposit cannot pay

**VERIFIED**, both from metadata error docs and from observed dry-run failures:

| Error | Doc string (from chain) | When |
|---|---|---|
| `StorageDepositNotEnoughFunds` (0x17 / index 23) | *"Origin doesn't have enough balance to pay the required storage deposits."* | Neither usable native nor PGAS covers the deposit |
| `StorageDepositLimitExhausted` (0x18 / index 24) | *"More storage was created than allowed by the storage deposit limit."* | The caller's own `storage_deposit_limit` is below the requirement |

The call **reverts**. Nothing is written, no partial state, no debt is recorded — there is no such
thing as "owing" a deposit in `pallet-revive`. The deposit is collected up front as a hold at the
moment the storage is created, or the whole call fails. **VERIFIED** — 192 of 250 probed accounts hit
exactly this and produced no state.

Refunds go the other way: the hold is released to whoever *clears* the storage.
`PlazaHeads.clearHead(scope)` exists for precisely this ("Withdraw your head for `scope` and reclaim
the storage deposit it holds"). **UNKNOWN: whether a PGAS-funded deposit is refunded in PGAS.** The
`NativeDepositOf` doc bounds the *native* refund at that entry's amount and says nothing about the
non-native slice. No `clearHead` by a PGAS payer exists on chain to observe. **This is the one open
question on Q1 and it needs an experiment, not a read** — see §Open below.

---

## PGAS, for a developer

**What it is.** A sponsored, personhood-gated fungible asset on Asset Hub. `Assets` asset id
**2 000 000 000** (`Pgas::PgasAssetId`, raw `0x00943577`). Live state, 2026-07-29: total supply
**9 247 580 046 477** (≈ 924.76 PGAS at 10 decimals), **733** holder accounts, `min_balance`
**10 000 000**, and critically **`is_sufficient: true`** — a PGAS balance alone keeps an account alive,
so holders need no native existential deposit. `Assets.Metadata(2000000000)` is **unset**, so name,
symbol and decimals are not on chain; 10 decimals is **INFERENCE** from `PgasClaimAmount` and from the
1:1 planck-for-planck agreement between PGAS hold amounts and native-denominated deposits.

**How an account gets it.** `Pgas::claim_pgas(slot_index, target)`, quoted from the chain:

> ```
> /// Mint PGAS for a verified claim slot.
> ///
> /// Must be submitted with the [`AsPgas`] transaction extension, which
> /// verifies the ring-VRF proof and produces an [`Origin::ClaimAlias`]. The outer origin
> /// must be `None` (the extension replaces it with the local origin); any other origin is
> /// rejected.
> ```

So: prove personhood with a ring-VRF proof, get **`PgasClaimAmount` = 50 000 000 000 = 5 PGAS** per
claim, minted to any `target` you name. Rate limits are per person per day —
`MaxClaimsPerPeriodPerPerson` = **100**, `MaxClaimsPerPeriodPerLitePerson` = **40**
(*"Typically lower ... since lite personhood offers weaker sybil resistance than full personhood."*).
Double-claiming is blocked by `ClaimedGasAliases`, keyed `(day, alias)`, with error `AlreadyClaimed`
(*"This alias has already been used to claim PGAS in this period."*). So a lite person can mint up to
**200 PGAS/day**; the *target* need not be the claimant, which is what makes sponsoring another
account possible.

**What it can pay for.**

- **Transaction fees. VERIFIED** — `PgasAllowance` exists solely to emit `PGASFeePaid { who,
  actual_fee }`, *"paid by `who` in PGAS and burned"*. Note *burned*: fees in PGAS are destroyed, not
  transferred.
- **`pallet-revive` storage deposits, including brand-new contract storage. VERIFIED** — this
  document's Q1. Held, not burned: `AssetsHolder.Holds` with reason `Revive::StorageDepositReserve`.
- **Code-upload deposits. VERIFIED** — one live PGAS hold with reason
  `Revive::CodeUploadDepositReserve` (4 041 100 000).

**What it apparently cannot pay for.**

- **The `Revive::AddressMapping` deposit.** All 3 502 such holds are native, at 0.20052 PAS. No PGAS
  hold carries that reason. **INFERENCE** — absence of evidence over a decent sample, not a proof.
- **Anything on the Bulletin chain.** Bulletin's storage dispatchables are `feeless_if(true)` with no
  token cost at all; access is gated by *quota*, not by any balance. PGAS is irrelevant there in both
  directions.
- **`Assets` transfers of other assets, XCM fees, ED for non-sufficient assets, staking:** **UNKNOWN**,
  not probed.

**When an account cannot pay.** The call reverts with `StorageDepositNotEnoughFunds`. No debt, no
partial write, no dust penalty. Storage that already exists is never re-charged, so an account that
falls to zero can still overwrite what it already owns — it just cannot grow.

---

## Consolidated tag table

| # | Claim | Tag |
|---|---|---|
| 1 | `renew` / `force_renew` / `enable_auto_renew` contain no storer/author/content-owner check | **VERIFIED** (doc strings + bodies + absence of an error variant + absence of any account field in `TransactionInfo`) |
| 2 | `disable_auto_renew` *does* check ownership — of the registration, not the content | **VERIFIED** |
| 3 | A renewal charges the caller's authorization quota | **VERIFIED** (`check_signed` → `AuthorizationScope::Account(who)`; `PermanentAllowanceExceeded` doc says "the signer's") |
| 4 | `force_renew`/`store` prefer a preimage authorization over the caller's when one exists for that hash | **VERIFIED** in code; **dormant** on this chain (0 preimage authorizations) |
| 5 | `(block, index)` is recoverable from a content hash via `TransactionByContentHash` | **VERIFIED** — 5 659/5 659 round-trip |
| 6 | `renew`/`force_renew` accept a content hash directly, so `(block, index)` is not needed at all | **VERIFIED** (`TransactionRef` enum in metadata) |
| 7 | CID → content hash is a pure client-side multihash parse | **VERIFIED** — 6/6 reconstructed CIDs resolved on a public gateway |
| 8 | `TransactionByContentHash` is deleted at expiry; a missed renewal is unrecoverable on chain | **VERIFIED** (`on_initialize`; `do_process_auto_renewals` doc: *"the data is gone"*) |
| 9 | `AuthorizationPeriod` == `RetentionPeriod` == 201 600 blocks | **VERIFIED** two ways (constant + storage; expiration spread) |
| 10 | 255 authorizations, all Account-scoped, modal grant 10 tx / 4 MiB (155 accounts, 60.8 %) | **VERIFIED** |
| 11 | Zero renewals have ever occurred (9 551 entries, all `Store`); `AutoRenewals` empty; expiry is starting now | **VERIFIED** |
| 12 | `renew`/`enable_auto_renew` attribute the renewer in events; `force_renew` does not | **VERIFIED** from event definitions |
| 13 | **`pallet-revive` storage deposits are payable from PGAS** | **VERIFIED** — 21 live PGAS holds with `Revive::StorageDepositReserve`; 250/250 dry-run predictor |
| 14 | 128 accounts with zero native balance can allocate fresh contract storage | **VERIFIED** |
| 15 | The PGAS deposit path is not in a transaction extension (bare `ReviveApi_call` shows it) | **VERIFIED**; that it therefore applies to `Revive::call` is **INFERENCE** |
| 16 | 0.00264 PAS-or-PGAS per new 32-byte EVM slot; 0.01584 for a fresh `setHead` with a 59-char CID | **VERIFIED** by length sweep |
| 17 | Overwriting your own existing head with a same-length CID costs ~0 | **INFERENCE** from the only-new-slots-charged pattern |
| 18 | An unpayable deposit reverts the call with `StorageDepositNotEnoughFunds`; no debt is recorded | **VERIFIED** |
| 19 | `Revive::AddressMapping` deposit (0.20052 PAS) is native-only | **INFERENCE** (all 3 502 holds native; no PGAS hold has that reason) |
| 20 | Mappings can exist without the 0.20052 PAS hold (`AutoMap = true`) | **INFERENCE** (zero-native mapped accounts have `reserved = 0`) |
| 21 | PGAS has 10 decimals and is 1:1 with PAS for deposit purposes | **INFERENCE** (`Assets.Metadata` unset; hold amounts equal planck-denominated deposits exactly) |
| 22 | Whether a PGAS-funded storage deposit is refunded in PGAS on `clearHead` | **UNKNOWN** |
| 23 | Whether native is tried before PGAS, or the reverse | **UNKNOWN** — consistent with native-first, but all 21 PGAS payers had exactly-ED native, so unprovable read-only |
| 24 | Whether the Products host's signing surface will accept a hand-encoded `force_renew` call | **UNKNOWN** |
| 25 | Whether the personhood gate stays at lite-or-full | **UNKNOWN** — not derivable from chain; ask Products |

---

## Open items that cannot be settled read-only

Each needs a signed transaction, which means a human with a funded key.

**1. Does a third-party `force_renew` actually succeed on chain?**
Everything above says yes, but there are **zero renewals in this chain's history**, so nothing has
ever exercised the path. *Experiment:* from an account holding a Bulletin authorization, call
`force_renew(TransactionRef::ContentHash(h))` for a content hash **stored by a different account**.
Confirm (a) it succeeds, (b) a `Renewed` event fires, (c) a `kind: Renew` entry appears in
`Transactions[current_block]`, (d) `TransactionByContentHash[h]` moves to the new block, (e) the
**caller's** `bytes_permanent` increases by `size` and the original storer's does not.
*Needs from a human:* one Bulletin-authorized signer and one signature. Cost: quota only, no tokens
(`feeless_if(true)`). **Do this before committing to the donation feature** — it is cheap and it is
the whole feature's foundation.

**2. Is a PGAS-funded storage deposit refunded in PGAS?**
*Experiment:* from a zero-native, PGAS-funded account, `setHead` into a fresh scope (deposit taken in
PGAS, verifiable as a new `AssetsHolder.Holds` row), then `clearHead(scope)`, then re-read
`AssetsHolder.BalancesOnHold` and the account's PGAS balance. If the hold releases and the PGAS
returns, the zero-balance content model is fully closed. If the refund is native-only, deposits
become a one-way PGAS burn and every write permanently consumes claim budget — which changes the
economics but not the feasibility.
*Needs from a human:* one zero-native PGAS-holding key and two signatures.

**3. Can more than one account hold a scheduled `renew` for the same content hash?**
The code says no (`AutoRenewalAlreadyEnabled` in `check_signed`). *Experiment:* two accounts call
`renew` on the same content hash; confirm the second is rejected at pool admission. Only relevant if
you build on `renew` rather than `force_renew`; §2a recommends the latter, which sidesteps it.

**4. Does the `Revive::AddressMapping` deposit ever land on an app user?**
*Resolution:* ask the Products team which account shape a host-managed user gets — `H160`-native
(no mapping needed) or `AccountId32` (`map_account`, 0.20052 PAS native). This is the only remaining
native-balance requirement in the zero-balance story.

---

## What changes in our design

1. **The donation/preservation screen is buildable.** A non-storer can renew. Combined with the
   already-established fact that a granted Bulletin allowance is prompt-free (the host persists a
   `slotAccountKey` from the `Allocated` response and signs with it), renewal needs no user
   signature — so "spend my quota to preserve someone else's post" is a one-tap action.
2. **Build it on `force_renew`, not `renew`.** `renew` is a scheduler that fires up to 14 days later
   and allows only one preserver per item; `force_renew` is synchronous, unrestricted, and gives the
   UI something to confirm. It is not in the SDK — you will encode the call yourself. Verify item 1
   above first.
3. **No schema change.** Store the CID, as you already do. `(block, index)` is derivable, and
   `force_renew` accepts a content hash anyway. What you *should* add is a read-time expiry
   computation — `TransactionByContentHash[h].block + RetentionPeriod` — and enough headroom in the
   UI that "nearing expiry" means days, not hours. 25 % of the chain's live content expires within a
   day right now.
4. **Budget renewals against `bytes_allowance`, not transaction count.** `store` saturates softly;
   `renew` hard-fails. A donor with the modal 4 MiB grant can preserve ~4 MiB of other people's bytes
   per authorization period, and `bytes_permanent` does not reset until the authorization rolls over.
   Surface remaining renewal capacity in the UI, because exhausting it is a hard failure.
5. **Drop the deposit worry from the content model.** `DelegateFaucet` does not need to become a real
   subsidy for storage-deposit reasons. A user with one PGAS claim can fund ~315 fresh contract
   storage writes. Keep the faucet sized for whatever else needs native, and re-check item 2 to see
   whether deposits are recoverable or a slow burn.
6. **Prefer `H160` user accounts.** It avoids the `map_account` question entirely, and it is the shape
   Plaza's session-wallet delegate pattern already produces.

---

*All measurements 2026-07-29. Asset Hub `specVersion` 2004002 at head 11578238; Bulletin
`specVersion` 2003001 at head 286259. Devnet state moves; re-run the scripts in §0 before relying on
any specific count.*
