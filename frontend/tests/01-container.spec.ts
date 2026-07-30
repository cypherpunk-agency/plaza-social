/**
 * Step 2 of the harness brief: prove `@parity/host-api-test-sdk` actually
 * provides a host container to a product built on `@parity/product-sdk`.
 *
 * These tests print their findings; the assertions are deliberately loose so a
 * partial result is still recorded rather than aborting the run.
 */
import { test, expect } from './host-fixture';

test('test host embeds the product and product-sdk sees a container', async ({ testHost, probe }) => {
  await testHost.waitForConnection(60_000);

  const f = await probe.frame();
  expect(f.url()).toContain('5199');

  const detect = await probe.call('detectContainer');
  console.log('detectContainer =', JSON.stringify(detect, null, 2));

  const surface = await probe.call('surface');
  console.log('runtime surface =', JSON.stringify(surface, null, 2));
});

test('session handshake and account resolution', async ({ testHost, probe }) => {
  await testHost.waitForConnection(60_000);

  const rec = await probe.record('handshake');
  console.log('handshake =', JSON.stringify(rec.result, null, 2));
  console.log('handshake signingLog =', JSON.stringify(rec.signingLog, null, 2));
  console.log('handshake permissionLog =', JSON.stringify(rec.permissionLog, null, 2));
  console.log('grantedPermissions =', JSON.stringify(await testHost.getGrantedPermissions()));
});
