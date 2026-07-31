// Probe: WHO is allowed to write to the statement store, and for how long?
//
// This exists because of the failure that stopped every host-signed contract write from the
// **browser** host:
//
//     TxError: createTransaction failed: HostFailure: Submit failed, no allowance set for account
//
// An earlier pass established (from the live host bundle) that the string is a statement-store
// rejection — `{tag:'rejected', reason:'noAllowance'}` — and that the browser reaches the paired
// phone over an SSO channel whose transport IS the statement store. It concluded "the session went
// stale, sign in again". This script tests the next question, which that pass never asked:
//
//     ⭐ WHAT GRANTS A STATEMENT-STORE ALLOWANCE IN THE FIRST PLACE?
//
// The answer is in the Individuality chain's `Resources` pallet, and it is not a session at all:
//
//     Resources.set_statement_store_account(period, seq, target_account)
//       "The origin must be `Origin::StmtStoreAlias`, produced by the `AsResources`
//        (`RegisterStatementStoreAllowance(..)`) transaction extension AFTER PROOF VALIDATION."
//
// i.e. an anonymous ring-VRF **membership proof** — personhood. And the allowance is filed under a
// `period` (a day number) with a bounded `seq`, cleaned up by an offchain worker once the period
// plus `StmtStoreGraceWindow` has elapsed.
//
//   node scripts/probe-statement-allowance.mjs
//
// Read-only: storage and constant reads over WS. No keys, no extrinsics. Safe to re-run.

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";

/** The Individuality / People chain. Same endpoint `probe-personhood.mjs` uses. */
const PEOPLE_WS = process.env.PEOPLE_WS ?? "wss://people-paseo.rotko.net";

/**
 * The account that posted the first Plaza threads, resolved through `Revive.OriginalAccount` — NOT
 * derived. See `frontend/src/lib/recipient.ts`; a derived account is a different account.
 */
const USER_H160 = "0x18773c30d65de35027ac8cd19e98c0ddb9c44ef9";
const USER_SS58 = process.env.USER_SS58 ?? "5EJ3VTQLFVGHh2nrwpD9VyAFhYhhKnHxRTfGsGifFS4sx2rz";
/** Sampled from PeopleLite.LitePeople. Proves the read path returns a positive for somebody. */
const KNOWN_LITE_ACCOUNT = "5CiLV6SQPLCydU65LybzLpYcTwgYn9grXiTUoWkt46MSWc8P";

const DAY = 86400;
const today = Math.floor(Date.now() / 1000 / DAY);

const j = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x));

const hexOf = (v) =>
  v == null ? String(v)
  : typeof v.asHex === "function" ? v.asHex()
  : v instanceof Uint8Array ? "0x" + Buffer.from(v).toString("hex")
  : String(v);

/** `BigEndianU32` newtype -> the day number it encodes. */
const periodOf = (key) => {
  const hex = hexOf(key);
  return /^0x[0-9a-f]{8}$/i.test(hex) ? Number.parseInt(hex.slice(2), 16) : hex;
};

const client = createClient(getWsProvider(PEOPLE_WS));
try {
  const api = client.getUnsafeApi();

  console.log(`##### ${PEOPLE_WS}`);
  console.log(`today's period (unix days) = ${today}\n`);

  // ── 1. Does this chain carry the Resources pallet at all? ──────────────────────────────────────
  const has = (pallet, kind, item) => {
    try {
      return !!api[kind]?.[pallet]?.[item];
    } catch {
      return false;
    }
  };
  console.log("pallet presence:");
  for (const [p, k, i] of [
    ["Resources", "query", "StatementStoreAllowances"],
    ["Resources", "query", "StmtStoreAllowanceByAccount"],
    ["PeopleLite", "query", "LitePeople"],
    ["People", "query", "AccountToPersonalId"],
  ]) {
    console.log(`  ${p}.${i}  ${has(p, k, i) ? "present" : "ABSENT"}`);
  }

  // ── 2. The constants that decide how long an allowance lives. ──────────────────────────────────
  console.log("\nResources constants:");
  for (const name of [
    "StmtStoreSlotsPerPeriod",
    "LiteStmtStoreSlotsPerPeriod",
    "StmtStoreCleanupLimit",
    "StmtStoreReplacementCooldown",
    "StmtStoreGraceWindow",
    "AccountsApiAllowance",
    "PersonAuthDuration",
  ]) {
    try {
      const v = await api.constants.Resources[name]();
      console.log(`  ${name.padEnd(30)} ${j(v)}`);
    } catch (error) {
      console.log(`  ${name.padEnd(30)} ERR ${error?.message ?? error}`);
    }
  }

  // ── 3. Who currently HAS an allowance, and for which period? ───────────────────────────────────
  //
  // ⭐ The period histogram is the load-bearing read. If every live entry names today (or today-1
  // inside the grace window) then allowances are DAILY and expire on their own, and "the session
  // went stale" is a mis-description of a clock.
  try {
    const entries = await api.query.Resources.StatementStoreAllowances.getEntries();
    console.log(`\nResources.StatementStoreAllowances: ${entries.length} entries`);
    const byPeriod = new Map();
    for (const e of entries) {
      // ⚠️ The period key is a `BigEndianU32` NEWTYPE, not a number — `Number(keyArgs[0])` is `NaN`
      // and a histogram built on it silently collapses to one bogus bucket. It decodes as a
      // FixedSizeBinary, so read the hex.
      const period = periodOf(e.keyArgs[0]);
      byPeriod.set(period, (byPeriod.get(period) ?? 0) + 1);
    }
    for (const [period, n] of [...byPeriod].sort((a, b) => a[0] - b[0])) {
      const delta = period - today;
      console.log(
        `  period ${period} (${delta === 0 ? "TODAY" : `${delta > 0 ? "+" : ""}${delta} d`})  ${n} allowance(s)`,
      );
    }
    if (entries.length) {
      const since = entries.map((e) => Number(e.value?.since ?? 0)).filter(Boolean).sort((a, b) => a - b);
      const iso = (t) => new Date(t * 1000).toISOString();
      console.log(`  oldest 'since' ${iso(since[0])}   newest 'since' ${iso(since.at(-1))}`);
      console.log(`  sample key ${entries[0].keyArgs.map(hexOf).join(" / ")} -> ${j(entries[0].value)}`);
    }
    // Does anything on this list belong to our user's own account? (It should not — the SSO channel
    // signs with an ephemeral session account, not the product account — but rule it out.)
    const mine = entries.filter((e) => e.value?.account_id === USER_SS58);
    console.log(`  entries naming our user's account: ${mine.length}`);
  } catch (error) {
    console.log(`\nResources.StatementStoreAllowances: ERR ${error?.message ?? error}`);
  }

  try {
    const rev = await api.query.Resources.StmtStoreAllowanceByAccount.getEntries();
    console.log(`Resources.StmtStoreAllowanceByAccount: ${rev.length} entries`);
    if (rev.length) console.log(`  sample: ${j(rev[0].keyArgs)}`);
  } catch (error) {
    console.log(`Resources.StmtStoreAllowanceByAccount: ERR ${error?.message ?? error}`);
  }

  // ── 4. Is OUR user a person at all? ────────────────────────────────────────────────────────────
  //
  // If not, no ring-VRF proof exists for them, so `set_statement_store_account` can never be called
  // on their behalf and no statement-store allowance can ever be issued — which would make the
  // browser host's SSO channel permanently unusable for this account, and "sign in again" useless.
  console.log(`\nour user: H160 ${USER_H160}`);
  console.log(`          SS58 ${USER_SS58}   (resolved via Revive.OriginalAccount, never derived)`);
  for (const [label, addr] of [
    ["our user", USER_SS58],
    ["a known lite person (control)", KNOWN_LITE_ACCOUNT],
  ]) {
    let lite = "ERR";
    let full = "ERR";
    try {
      lite = (await api.query.PeopleLite.LitePeople.getValue(addr)) ? "LITE PERSON" : "not lite";
    } catch (error) {
      lite = `ERR ${error?.message ?? error}`;
    }
    try {
      const id = await api.query.People.AccountToPersonalId.getValue(addr);
      full = id ? `FULL PERSON (${j(id)})` : "not full";
    } catch (error) {
      full = `ERR ${error?.message ?? error}`;
    }
    console.log(`  ${addr}  ${lite} / ${full}   (${label})`);
  }

  const counts = async (pallet, item) => {
    try {
      return (await api.query[pallet][item].getEntries()).length;
    } catch {
      return "ERR";
    }
  };
  console.log(`\n  PeopleLite.LitePeople        ${await counts("PeopleLite", "LitePeople")} entries`);
  console.log(`  People.AccountToPersonalId   ${await counts("People", "AccountToPersonalId")} entries`);
  console.log(`  Resources.Consumers          ${await counts("Resources", "Consumers")} entries`);

  console.log(`
  => A statement-store allowance is a PERSONHOOD-GATED DAILY SLOT, not a session property.
     Only \`Resources.set_statement_store_account\` and
     \`Resources.set_friend_request_statement_account_for_sequence\` raise one, and both demand an
     origin produced from an anonymous ring-VRF membership proof over People / LitePeople. This
     runtime has no \`Statement\` pallet, so there is no balance-derived fallback.

  => Therefore, on the BROWSER host — whose SSO channel to the phone rides the statement store —
     an account that cannot produce such a proof can never ship a signing request, and
     "sign in again" cannot help: pairing is read-only on the browser side and a fresh pairing
     mints a NEW random statement account needing the same grant. See gotchas.md.

  ⚠️ CAVEAT ON THE PERSONHOOD READ ABOVE. The account we can see is the PRODUCT account, derived
     per product from the user's root entropy. Personhood is registered against the identity
     account the Polkadot app holds, and there is no on-chain reverse map. "This product account is
     in neither collection" is [V]; "this user has no personhood" is NOT.`);
} finally {
  client.destroy();
}
