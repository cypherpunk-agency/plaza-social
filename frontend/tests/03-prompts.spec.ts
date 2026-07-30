/**
 * Questions 3b, 3c, 3d: which operations reach the host's signing handler, and
 * in what order.
 *
 * How to read the evidence. The test host **auto-signs everything and never
 * prompts** — it has no modal. So it cannot directly observe "did the user get a
 * prompt". What it does observe exactly is: which host wire calls an operation
 * makes, and which of them land in `signingLog` (populated by exactly the six
 * signing handlers: createTransaction, signPayload, signRaw, and their
 * WithLegacyAccount variants). On a real host those six are the handlers that
 * reach a modal, so a `signingLog` entry is the faithful proxy for "this would
 * have prompted" and an empty log is the faithful proxy for "prompt-free".
 *
 * Nothing here broadcasts. `tx.sign()` returns signed bytes and never submits.
 */
import { test, expect } from './host-fixture';
import { PASEO_BULLETIN } from './host-fixture';
import { PASEO_ASSET_HUB } from '@parity/host-api-test-sdk/playwright';

const ASSET_HUB = PASEO_ASSET_HUB.genesisHash;
const BULLETIN = PASEO_BULLETIN.genesisHash;

test('3b — Bulletin TransactionStorage.store, host-signed', async ({ testHost, probe }) => {
  await testHost.waitForConnection(60_000);

  console.log('Bulletin pallets =', JSON.stringify(await probe.call('listCalls', BULLETIN), null, 2));
  console.log(
    'Bulletin TransactionStorage calls =',
    JSON.stringify(await probe.call('listCalls', BULLETIN, 'TransactionStorage'), null, 2),
  );

  const rec = await probe.record('chainSignTx', BULLETIN, 'TransactionStorage', 'store', {
    data: { __text: 'plaza probe payload' },
  });
  console.log('bulletin store sign =', JSON.stringify(rec.result, null, 2));
  console.log('signingLog =', JSON.stringify(rec.signingLog.map((e) => e.type), null, 2));
});

test('3b — the real CloudStorageClient, up to checkAuthorization (no send)', async ({ testHost, probe }) => {
  await testHost.waitForConnection(60_000);
  const rec = await probe.record('bulletinStore', 'paseo');
  console.log('CloudStorageClient =', JSON.stringify(rec.result, null, 2));
  console.log('signingLog =', JSON.stringify(rec.signingLog.map((e) => e.type)));
});

test('3b — the allowance-backed writes: preimage submit and statement submit', async ({ testHost, probe }) => {
  await testHost.waitForConnection(60_000);

  const pre = await probe.record('preimageSubmit', 'plaza probe preimage');
  console.log('preimageSubmit =', JSON.stringify(pre.result, null, 2));
  console.log('preimageSubmit signingLog =', JSON.stringify(pre.signingLog.map((e) => e.type)));
  console.log('host preimages =', JSON.stringify((await testHost.getPreimages()).map((p) => ({ key: p.key, fromProduct: p.fromProduct }))));

  const st = await probe.record('statementSubmit', 'plaza/probe', 'hello from the probe');
  console.log('statementSubmit =', JSON.stringify(st.result, null, 2));
  console.log('statementSubmit signingLog =', JSON.stringify(st.signingLog.map((e) => e.type)));
  console.log('submitted statements =', (await testHost.getSubmittedStatements()).length);
});

test('3c — a Revive contract call, host-signed', async ({ testHost, probe }) => {
  await testHost.waitForConnection(60_000);

  console.log('Asset Hub Revive calls =', JSON.stringify(await probe.call('listCalls', ASSET_HUB, 'Revive'), null, 2));

  // A Revive.call with a zero dest / empty input. It never leaves the browser —
  // we sign and discard — so the target need not exist.
  // Two things that cost real time to discover, both from the metadata listing
  // above plus trial and error against PAPI's compatibility check:
  //   - the weight field is `weight_limit`, not `gas_limit`
  //   - `H160`/`H256` slots want a PLAIN HEX STRING. Passing `Binary.fromHex` or
  //     `FixedSizeBinary.fromHex` fails with
  //     `Incompatible runtime entry Tx(Revive.call)`, which reads like a missing
  //     call but is actually an argument-shape rejection.
  const rec = await probe.record('chainSignTx', ASSET_HUB, 'Revive', 'call', {
    dest: '0x1111111111111111111111111111111111111111',
    value: '__bigint:0',
    weight_limit: { ref_time: '__bigint:1000000000', proof_size: '__bigint:100000' },
    storage_deposit_limit: '__bigint:0',
    data: { __bytes: '0xdeadbeef' },
  });
  console.log('revive call sign =', JSON.stringify(rec.result, null, 2));
  console.log('signingLog =', JSON.stringify(rec.signingLog.map((e) => e.type), null, 2));
  // The contrast with 3b: a Revive.call and a Bulletin store both produce
  // exactly one `createTransaction`. On the deployed host the allowance is what
  // decides whether that one call is silent; the shape of the call is identical.
  expect(rec.signingLog.map((e) => e.type)).toEqual(['createTransaction']);
});

test('3b/3c — the actual contrast, side by side', async ({ testHost, probe }) => {
  await testHost.waitForConnection(60_000);

  const bulletinTx = await probe.record('chainSignTx', BULLETIN, 'TransactionStorage', 'store', {
    data: { __text: 'plaza probe payload' },
  });
  const preimage = await probe.record('preimageSubmit', 'plaza probe payload');
  const statement = await probe.record('statementSubmit', 'plaza/probe', 'body');
  const contract = await probe.record('chainSignTx', ASSET_HUB, 'Revive', 'call', {
    dest: '0x1111111111111111111111111111111111111111',
    value: '__bigint:0',
    weight_limit: { ref_time: '__bigint:1000000000', proof_size: '__bigint:100000' },
    storage_deposit_limit: '__bigint:0',
    data: { __bytes: '0xdeadbeef' },
  });

  const table = {
    'Bulletin store, product-signed extrinsic': bulletinTx.signingLog.map((e) => e.type),
    'Bulletin content via host preimageSubmit': preimage.signingLog.map((e) => e.type),
    'Statement store createProofAuthorized + submit': statement.signingLog.map((e) => e.type),
    'Revive.call, product-signed extrinsic': contract.signingLog.map((e) => e.type),
  };
  console.log('signing handler calls per operation =', JSON.stringify(table, null, 2));

  expect(table['Bulletin content via host preimageSubmit']).toEqual([]);
  expect(table['Statement store createProofAuthorized + submit']).toEqual([]);
  expect(table['Bulletin store, product-signed extrinsic']).toEqual(['createTransaction']);
  expect(table['Revive.call, product-signed extrinsic']).toEqual(['createTransaction']);
});

test('3c/3d — plain extrinsic, product account vs user wallet account', async ({ testHost, probe }) => {
  await testHost.waitForConnection(60_000);

  const asProduct = await probe.record('chainSignTx', ASSET_HUB, 'System', 'remark', {
    remark: { __text: 'probe/product' },
  });
  console.log('System.remark as product account =', JSON.stringify(asProduct.result, null, 2));
  console.log('  signingLog =', JSON.stringify(asProduct.signingLog.map((e) => e.type)));

  const asUser = await probe.record('chainSignTx', ASSET_HUB, 'System', 'remark', { remark: { __text: 'probe/user' } }, true);
  console.log('System.remark as legacy (user wallet) account =', JSON.stringify(asUser.result, null, 2));
  console.log('  signingLog =', JSON.stringify(asUser.signingLog.map((e) => e.type)));
});

test('3d — raw-bytes signing always reaches the signing handler', async ({ testHost, probe }) => {
  await testHost.waitForConnection(60_000);
  const rec = await probe.record('hostSignBytes', 'plaza probe');
  console.log('signBytes =', JSON.stringify(rec.result, null, 2));
  console.log('signingLog =', JSON.stringify(rec.signingLog, null, 2));
  expect(rec.signingLog.length).toBeGreaterThan(0);
});

test('3d — a granted BulletinAllowance does not change what the host signs', async ({ testHost, probe }) => {
  await testHost.waitForConnection(60_000);

  const before = await probe.record('hostSignBytes', 'before-allowance');
  await probe.call('requestAllowance', 'BulletinAllowance', undefined);
  await probe.call('requestAllowance', 'AutoSigning', undefined);
  const after = await probe.record('hostSignBytes', 'after-allowance');

  console.log('signing entries before allowance =', before.signingLog.length);
  console.log('signing entries after  allowance =', after.signingLog.length);
  // The test host has no allowance-aware short circuit; recording that fact is
  // the point of this test.
  expect(after.signingLog.length).toBe(before.signingLog.length);
});
