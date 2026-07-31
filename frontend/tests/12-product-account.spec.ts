/**
 * ⭐ THE CONTROLLED EXPERIMENT: what does Plaza's product account actually depend on?
 *
 * The open question is a user report — one identity, two different addresses, phone vs
 * browser-paired-by-QR. `@parity/product-sdk-keys` says the derivation is
 * `publicSoft(rootPublicKey, ["product", productId, derivationIndex])`: three inputs, none of
 * them a device or an origin. That is a reading of source. This file turns it into a
 * measurement of the *running app*, which is the thing that was missing.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * HOW IT WORKS, AND WHY THE RESULT IS TRUSTWORTHY DESPITE THE DERIVATION BEING FAKE.
 *
 * The test host does **not** implement the real derivation. `handleAccountGet` in
 * `dist/host-bundle.js` is:
 *
 *     const key = `${dotNsIdentifier}/${derivationIndex}`;
 *     if (productAccounts[key]) return keypair(productAccounts[key].uri);
 *     return keypair(`${rootUri}//${dotNsIdentifier}/${derivationIndex}`);
 *
 * — a `@polkadot/keyring` URI derivation, not sr25519 public-soft HDKD over
 * `["product", id, index]`. So **the addresses here are not the addresses a real host
 * produces** and nothing in this file can be compared with `0xda46…712e` or `0x18773c30…`.
 *
 * What it *is* is a **key-observation probe**. The `productAccounts` map is keyed on exactly
 * the two values the wire carries — `dotNsIdentifier` and `derivationIndex` — so pointing one
 * key at a distinguishable account and watching whether Plaza's address moves tells you,
 * with no ambiguity, which key the app requested. That is a fact about **Plaza's request**,
 * and Plaza's request is real. The host's arithmetic afterwards is the only fake part.
 *
 * No address is hardcoded. Every conclusion is drawn from whether two runs agree or differ,
 * so it cannot rot when a dev seed changes.
 *
 * ⛔ WHAT THIS CANNOT SETTLE. The reported split is between two *roots*, and the root lives
 * in the wallet. A simulator that is handed its root as configuration can never tell you why
 * a real phone and a real paired browser presented different ones. See the final test.
 */
import { test, expect, type Page } from '@playwright/test';
import { createTestHostServer, type Account } from '@parity/host-api-test-sdk';
import { PLAZA_URL, PLAZA_NETWORKS } from './plaza-fixture';

/**
 * ⛔ Tracing off — eight full Plaza boots in one test, each streaming ~4 MB of chain metadata
 * through the proxied RPC. A continuously-recording trace OOM-killed the Playwright worker on
 * the sibling screenshot spec (`code=134`); do not re-enable it here without checking that.
 */
test.use({ trace: 'off', video: 'off' });

interface Scenario {
  productUrl?: string;
  accounts?: Account[];
  productAccounts?: Record<string, Account>;
}

interface Observation {
  /** `account.ss58` as the app itself reports it in DEBUG / IDENTITY. */
  ss58: string;
  /** `account.h160` — what `msg.sender` would be. */
  h160: string;
  /** `asked.productIdentifier` — what Plaza believes it asked the host for. */
  askedProductIdentifier: string;
  askedDerivationIndex: string;
  pageOrigin: string;
}

function field(text: string, key: string): string {
  // The panel renders `key: value` then the provenance line under it. Values never contain a
  // newline, so line-scoped matching is exact.
  const m = new RegExp(`^\\s*${key.replaceAll('.', '\\.')}:\\s*(.+)$`, 'm').exec(text);
  return m ? m[1].trim() : '(not found)';
}

/**
 * Boot Plaza against a freshly configured test host and read its identity record.
 *
 * A new `createTestHostServer` per scenario rather than the shared fixture: `productAccounts`
 * is baked into the generated host page at construction time and cannot be changed afterwards,
 * which is precisely the variable under test.
 */
async function observe(page: Page, scenario: Scenario): Promise<Observation> {
  const productUrl = scenario.productUrl ?? PLAZA_URL;
  const server = await createTestHostServer({
    productUrl,
    accounts: scenario.accounts ?? ['alice'],
    networks: PLAZA_NETWORKS,
    productAccounts: scenario.productAccounts,
  });
  try {
    // ≥ `xl`, so the sidebar is a real column and `Settings` is one click away rather than
    // behind the drawer. The account does not depend on the viewport; the navigation does.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(server.url);
    await page.waitForFunction(() => !!window.__TEST_HOST__, { timeout: 30_000 });

    let frame = null;
    for (let i = 0; i < 200 && !frame; i++) {
      frame =
        page.frames().find((f) => f !== page.mainFrame() && !f.isDetached() && f.url().startsWith(productUrl)) ??
        null;
      if (!frame) await page.waitForTimeout(100);
    }
    if (!frame) throw new Error(`Plaza iframe (${productUrl}) never appeared`);
    await frame.waitForSelector('h1', { timeout: 30_000 });

    // The account resolves during the session handshake, well before the first chain read, so
    // there is no need to wait out the 880 kB metadata fetch here.
    await frame.waitForTimeout(3_000);
    await frame.getByRole('button', { name: /Settings/i }).first().click();
    await frame.waitForSelector('text=DEBUG / IDENTITY', { timeout: 30_000 });

    // ⚠️ POLL FOR THE ACCOUNT, do not sleep a fixed amount. A too-short wait renders
    // `account.ss58: unavailable — the wallet handshake never ran`, which is a real value of a
    // real field and would go into the matrix as a data point rather than as "not ready yet".
    let text = '';
    for (let i = 0; i < 40; i++) {
      text = await frame.locator('body').innerText();
      if (/^\s*account\.ss58:\s*5/m.test(text)) break;
      await frame.waitForTimeout(1_000);
    }

    return {
      ss58: field(text, 'account.ss58'),
      h160: field(text, 'account.h160'),
      askedProductIdentifier: field(text, 'asked.productIdentifier'),
      askedDerivationIndex: field(text, 'asked.derivationIndex'),
      pageOrigin: field(text, 'page.origin'),
    };
  } finally {
    await page.evaluate(() => window.__TEST_HOST__?.dispose()).catch(() => {});
    await server.close();
  }
}

test.describe('product account — what does it depend on?', () => {
  test('the whole matrix, one variable at a time', async ({ page }) => {
    // Eight full app boots, each with its own host server. Slow by construction, not by fault.
    test.setTimeout(600_000);
    const results: Record<string, Observation> = {};

    const arms: Array<[string, Scenario, string]> = [
      // 1. Baseline. Root = Alice, no overrides.
      ['baseline', {}, 'root Alice, nothing overridden'],
      // 2. Point `plaza.dot/0` at a different account. If the address moves, that key — and
      //    only that key — is what Plaza asked for.
      ['mapPlazaDot0', { productAccounts: { 'plaza.dot/0': 'charlie' } }, 'plaza.dot/0 → charlie'],
      // 3. Same key, a different target. Confirms (2) was a hit, not a coincidence.
      ['mapPlazaDot0Other', { productAccounts: { 'plaza.dot/0': 'dave' } }, 'plaza.dot/0 → dave'],
      // 4. ⭐ THE LANDMINE. We are deployed as `plaza-social.dot`. Is it ever asked for?
      [
        'mapPlazaSocial',
        { productAccounts: { 'plaza-social.dot/0': 'charlie' } },
        'plaza-social.dot/0 → charlie',
      ],
      // 5. Derivation index. The SDK hardcodes 0 on the dappName path.
      ['mapIndex1', { productAccounts: { 'plaza.dot/1': 'charlie' } }, 'plaza.dot/1 → charlie'],
      // 6. Origin as the host would key it. `productIdentifier()` returns `location.hostname`
      //    and the identity panel claims it is display-only — this checks that claim.
      [
        'mapOrigin',
        { productAccounts: { 'localhost/0': 'charlie', 'localhost:5200/0': 'charlie' } },
        'localhost/0 and localhost:5200/0 → charlie',
      ],
      // 7. A DIFFERENT ORIGIN entirely, same bytes. 127.0.0.1 is a different origin to
      //    localhost for every browser rule that matters (storage, CSP, cookies).
      ['otherOrigin', { productUrl: 'http://127.0.0.1:5200' }, 'served from 127.0.0.1:5200'],
      // 8. A different ROOT. The one input the app cannot influence.
      ['rootBob', { accounts: ['bob'] }, 'root Bob'],
    ];

    // ⚠️ Every arm runs even if one fails, and the table prints before any assertion. A matrix
    // that aborts on arm 7 tells you nothing about arms 1–6, which is the opposite of what an
    // experiment is for.
    const failures: string[] = [];
    for (const [name, scenario, what] of arms) {
      try {
        results[name] = await observe(page, scenario);
      } catch (e) {
        failures.push(`${name} (${what}): ${String(e).split('\n')[0]}`);
      }
    }

    console.log('---- product account matrix ----');
    for (const [name, , what] of arms) console.log(`${name.padEnd(18)} = ${what}`);
    for (const [name, o] of Object.entries(results)) {
      console.log(
        `${name.padEnd(18)} ss58=${o.ss58}  h160=${o.h160}  asked=${o.askedProductIdentifier}` +
          `  idx=${o.askedDerivationIndex}  origin=${o.pageOrigin}`,
      );
    }

    if (failures.length) console.log('---- arms that did not run ----\n' + failures.join('\n'));
    expect(failures, 'every arm must run for the matrix to mean anything').toEqual([]);

    const base = results.baseline.ss58;
    expect(base).toMatch(/^5/);

    // ⭐ Plaza asks for `plaza.dot`, index 0 — measured, not inferred from the SDK source.
    expect(results.mapPlazaDot0.ss58, 'mapping plaza.dot/0 must change the account').not.toBe(base);
    expect(
      results.mapPlazaDot0Other.ss58,
      'a different target for the same key must give a different account',
    ).not.toBe(results.mapPlazaDot0.ss58);

    // ⭐ It NEVER asks for `plaza-social.dot`, the name it is actually deployed under.
    expect(results.mapPlazaSocial.ss58, 'plaza-social.dot/0 is never requested').toBe(base);

    // Index is 0.
    expect(results.mapIndex1.ss58, 'derivation index 1 is never requested').toBe(base);

    // ⭐ The ORIGIN takes no part. Neither a hostname-keyed override nor a genuinely different
    // origin moves the address.
    expect(results.mapOrigin.ss58, 'a hostname-keyed override is never requested').toBe(base);
    expect(results.otherOrigin.ss58, '127.0.0.1 derives the same account as localhost').toBe(base);
    expect(results.otherOrigin.pageOrigin).not.toBe(results.baseline.pageOrigin);

    // ⭐ The ROOT is the only thing that moves it.
    expect(results.rootBob.ss58, 'a different root account gives a different product account').not.toBe(
      base,
    );

    // And the app's own self-report agrees with the wire.
    expect(results.baseline.askedProductIdentifier).toBe('plaza.dot');
    expect(results.baseline.askedDerivationIndex).toBe('0');
  });

  test('what this experiment CANNOT answer', async () => {
    // Deliberately assertion-free. It exists so the limitation is in the test output next to
    // the result, where anyone reading a green run will see it.
    console.log(
      [
        'The simulator is handed its root account as configuration (`accounts: [...]`).',
        'It therefore cannot say why a real phone and a real browser-paired-by-QR session',
        'presented different roots — that happens inside the wallet, above the product API,',
        'and no product-side probe can see it. What the matrix above rules out is everything',
        'on OUR side of the boundary: origin, hostname, iframe nesting, derivation index and',
        'the dotNsIdentifier are all now measured, and only one of them is even variable.',
        '',
        'The remaining candidate is exactly what STATUS.md already says: two roots. Settling',
        'that needs the two devices and `account.primaryUsername` from DEBUG / IDENTITY on',
        'each — not another simulation.',
      ].join('\n'),
    );
  });
});
