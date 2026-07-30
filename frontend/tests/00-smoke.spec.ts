/**
 * Bare smoke test: does the test host serve a page, embed the product, and does
 * anything at all show up in either console? Run this first when the harness
 * misbehaves — it makes no SDK assumptions and never waits on a connection.
 */
import { test } from './host-fixture';

test('host page loads and iframe boots', async ({ testHost }) => {
  const page = testHost.page;
  const messages: string[] = [];
  page.on('console', (m) => messages.push(`[host:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => messages.push(`[host:pageerror] ${e.message}`));
  page.on('frameattached', (f) => messages.push(`[frameattached] ${f.url()}`));

  await page.waitForTimeout(15_000);

  console.log('host page url =', page.url());
  console.log('frames =', JSON.stringify(page.frames().map((f) => f.url()), null, 2));
  console.log('connectionStatus =', await page.evaluate(() => window.__TEST_HOST__?.getConnectionStatus?.()));
  console.log('chainStatus =', await page.evaluate(() => window.__TEST_HOST__?.getChainStatus?.()));
  console.log('console:\n' + messages.join('\n'));

  const f = page.frames().find((x) => x !== page.mainFrame());
  if (f) {
    console.log('iframe body text =', await f.evaluate(() => document.body?.innerText ?? '(none)').catch((e) => String(e)));
  } else {
    console.log('no child frame attached');
  }
});
