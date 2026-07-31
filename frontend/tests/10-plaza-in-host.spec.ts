/**
 * ⭐ PLAZA, RUNNING INSIDE THE SIMULATED HOST.
 *
 * Not the probe app — `frontend/dist`, the bundle `pad` publishes. Everything asserted here
 * went through `openBackend()` → `openHostSession()`, so a failure is a failure of the app's
 * own code path, not of a test-only re-implementation of it.
 *
 * ⚠️ WHAT A GREEN RUN HERE IS NOT EVIDENCE FOR. The simulated host auto-approves every
 * permission, allocates every resource unconditionally, and signs with a dev key. It cannot
 * tell you whether a real phone would prompt, grant, or succeed — and it models the
 * native-container-vs-browser-over-SSO difference not at all. See `docs/products-platform/
 * simulated-host.md`.
 */
import { test, expect, VIEWPORTS } from './plaza-fixture';

// Tracing records continuously and this test holds a full Plaza session open while ~4 MB of
// chain metadata streams through the proxied RPC — enough to OOM the Playwright worker on the
// longer sibling specs. Nothing here is debugged from a trace.
test.use({ trace: 'off', video: 'off' });

test('Plaza boots inside the container and reports a live session', async ({ testHost, plaza }) => {
  const frame = await plaza.open('', VIEWPORTS.desktop);
  await testHost.waitForConnection(60_000);

  const wordmark = await frame.locator('h1').first().innerText();
  expect(wordmark).toContain('PLAZA');

  // The app asks the host for permissions on the read path; `ChainSubmit` and `GetUserId` are
  // the two that a real host enforces, and both are requested by `session.ts`.
  const perms = await testHost.getGrantedPermissions();
  console.log('granted permissions =', JSON.stringify(perms));
  console.log('permission log =', JSON.stringify(await testHost.getPermissionLog(), null, 2));

  // Give the chain reads a moment; `getHeadsPaged` is a real call to the real devnet chain,
  // and the first one pays for ~880 kB of Asset Hub metadata over the host's proxied RPC.
  await frame.waitForTimeout(45_000);

  const body = await frame.locator('body').innerText();
  console.log('---- rendered text (first 2000 chars) ----');
  console.log(body.slice(0, 2000));
  console.log('---- app console ----');
  console.log(plaza.logs().slice(-60).join('\n'));

  await plaza.shot('host-desktop-boot');
});
