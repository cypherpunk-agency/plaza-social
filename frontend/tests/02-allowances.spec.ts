/**
 * Question 3a: does `requestResourceAllocation([{tag:'BulletinAllowance'}])`
 * succeed, what is in the response, and does the `BulletInAllowance` /
 * `BulletinAllowance` spelling mismatch matter?
 *
 * Caveat that the whole file must be read with: the test host's
 * `handleRequestResourceAllocation` maps every requested resource to
 * `{tag:'Allocated'}` unconditionally — see `dist/host-bundle.js`. So "succeeds"
 * here proves the *codec and transport* work, not that a real host would grant.
 */
import { test, expect } from './host-fixture';

test('BulletinAllowance — request, response shape, and logs', async ({ testHost, probe }) => {
  await testHost.waitForConnection(60_000);

  const rec = await probe.record('requestAllowance', 'BulletinAllowance', undefined);
  console.log('requestResourceAllocation(BulletinAllowance) =', JSON.stringify(rec.result, null, 2));
  console.log('signingLog =', JSON.stringify(rec.signingLog));
  console.log('permissionLog =', JSON.stringify(rec.permissionLog));
  console.log('grantedPermissions after =', JSON.stringify(await testHost.getGrantedPermissions()));
});

test('the BulletInAllowance (capital I) spelling', async ({ testHost, probe }) => {
  await testHost.waitForConnection(60_000);

  const good = await probe.call('requestAllowance', 'BulletinAllowance', undefined);
  const bad = await probe.call('requestAllowance', 'BulletInAllowance', undefined);
  console.log('BulletinAllowance (lowercase i) =', JSON.stringify(good, null, 2));
  console.log('BulletInAllowance (capital I)   =', JSON.stringify(bad, null, 2));
});

test('all four resource tags, ordering of outcomes', async ({ testHost, probe }) => {
  await testHost.waitForConnection(60_000);

  const all = await probe.call('requestAllowances', [
    'BulletinAllowance',
    'StatementStoreAllowance',
    'AutoSigning',
  ]);
  console.log('multi-tag request =', JSON.stringify(all, null, 2));

  const sc = await probe.call('requestAllowance', 'SmartContractAllowance', 0);
  console.log('SmartContractAllowance(0) =', JSON.stringify(sc, null, 2));

  const nonsense = await probe.call('requestAllowance', 'NotARealAllowance', undefined);
  console.log('bogus tag =', JSON.stringify(nonsense, null, 2));
});

test('allowance request produces no signing and no permission entry', async ({ testHost, probe }) => {
  await testHost.waitForConnection(60_000);
  const rec = await probe.record('requestAllowance', 'BulletinAllowance', undefined);
  expect(rec.signingLog).toHaveLength(0);
  expect(rec.permissionLog).toHaveLength(0);
});
