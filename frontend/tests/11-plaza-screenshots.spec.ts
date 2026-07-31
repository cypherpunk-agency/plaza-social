/**
 * ⭐⭐ SCREENSHOTS. Nobody in this project had ever seen this app before this file existed.
 *
 * The in-app Browser pane does not composite frames, so every layout, colour and contrast claim
 * in this repo is numeric inference from `getComputedStyle` / `getBoundingClientRect`.
 * Playwright renders in a real Chromium and can capture pixels.
 *
 * TWO SETS, and the difference decides how you read them:
 *
 *  - `host-*` — the REAL host backend inside the simulated container, reading the REAL devnet
 *    chain. The thread cards, the author display name and the timestamps all came off
 *    `PostRegistry` / `UserRegistry`. **Post bodies are missing**: the simulator's preimage
 *    lookup is an in-memory `Map` that never touches Bulletin, so every body renders as
 *    "(content no longer available)" — which is the app being honest, not a defect.
 *  - `fake-*` — the sanctioned dev seam `?backend=fake&caps=live`, still inside the container
 *    iframe so the geometry is identical. Its chain reader **answers empty on purpose**
 *    (`fake.ts`: "It invents no content"), so this set is the EMPTY-STATE review.
 *
 * ⛔ THERE IS NO CONFIGURATION IN WHICH THIS HARNESS SHOWS A POPULATED BOARD WITH REAL BODIES.
 * The host simulator cannot serve Bulletin content and the fake backend will not invent it.
 * Seeing real posts rendered still needs a real device — or a `fake.ts` that seeds a few
 * objects, which is a production-code change and therefore not this harness's to make.
 *
 * Output: `frontend/tests/.artifacts/screens/` (gitignored).
 */
import { test, expect, VIEWPORTS, SCREENSHOT_DIR } from './plaza-fixture';
import type { Frame } from '@playwright/test';

/**
 * ⛔ TRACING OFF FOR THIS FILE. `trace: 'retain-on-failure'` still records continuously, and
 * these tests keep a full Plaza session open for minutes while ~4 MB of chain metadata streams
 * through the proxied RPC. The trace buffer grew until the Playwright worker died with
 * `code=134` (V8 heap limit) — twice, at 8 and 9 minutes in, taking every screenshot with it.
 * The images ARE the artefact here; a trace of a screenshot tour is worth nothing.
 */
test.use({ trace: 'off', video: 'off' });

/** The fullest scenario the fake offers: writable, live, delegate authorised, no latency. */
const FAKE = '?backend=fake&caps=live&delegate=active&latency=0';

/**
 * Open the sidebar when it is a drawer. Below `xl` the nav is `hidden` and reachable only
 * through the `☰` control in the header (`Sidebar.tsx`); at and above `xl` that control does
 * not exist and this is a no-op.
 */
async function openNav(frame: Frame): Promise<boolean> {
  const menu = frame.locator('button[aria-controls]').first();
  if ((await menu.count()) && (await menu.isVisible())) {
    // Already open? `aria-expanded` is on the same control, so do not toggle it shut.
    if ((await menu.getAttribute('aria-expanded')) === 'true') return true;
    // `force` because the drawer's own backdrop can still be dismissing over the header. This
    // is a screenshot tour, not an interaction test — a click that has to be forced is not a
    // finding here, and losing the remaining six images to it would be.
    await menu.click({ timeout: 10_000, force: true });
    await frame.waitForTimeout(500);
    return true;
  }
  return false;
}

/**
 * Run one step of the tour and keep going if it fails. Every step is independent, and the whole
 * point of the file is to come back with as many pictures as possible — a missed surface should
 * cost that surface and nothing else.
 */
async function step(name: string, run: () => Promise<void>): Promise<void> {
  // The cap is belt-and-braces over the per-action timeouts inside each step: one wedged step
  // must not eat the whole test budget and take every later image down with it.
  const cap = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('step exceeded 60s')), 60_000).unref?.(),
  );
  try {
    await Promise.race([run(), cap]);
  } catch (e) {
    console.log(`[tour] ${name} FAILED: ${String(e).split('\n')[0]}`);
  }
}

/**
 * ⚠️ NOT `/^Forum$/`. The nav rows carry a leading glyph — `☰ Forum`, `⚙ Settings`, `@ 0x…` — so
 * the accessible name is never the bare word, and an anchored regex silently matches nothing and
 * then hangs on `click()` until the test times out. Cost one 4-minute run to find.
 */
const FORUM = /Forum/i;

async function clickNav(frame: Frame, label: RegExp): Promise<void> {
  await openNav(frame);
  await frame.getByRole('button', { name: label }).first().click({ timeout: 15_000 });
  await frame.waitForTimeout(1200);
}

/**
 * Walk every surface once and photograph it. Shared by the host and fake runs so the two sets
 * are directly comparable frame for frame.
 */
async function tour(
  plaza: { shot(name: string): Promise<string>; frame(): Promise<Frame> },
  frame: Frame,
  prefix: string,
): Promise<void> {
  await plaza.shot(`${prefix}-1-forum`);

  // ⚠️ THE COMPOSER GOES FIRST, BEFORE ANY THREAD IS OPENED. Below `xl` the detail pane
  // REPLACES the list, and returning to the Forum nav row does not clear the thread selection
  // — so "+ NEW THREAD" is off screen for the rest of the tour once you have tapped a card.
  // Ordering around that is cheaper than adding a back-navigation dance.
  await step(`${prefix}-2-composer`, async () => {
  const compose = frame.getByRole('button', { name: /NEW THREAD/i }).first();
  if ((await compose.count()) > 0 && (await compose.isVisible())) {
    await compose.click({ timeout: 15_000 });
    await frame.waitForTimeout(800);
    // Type into it: an empty form and a filled one look nothing alike, and the filled one is
    // the state a reviewer needs (line length, button states, character counters).
    // ⚠️ Address the TITLE and the BODY by element type, not by position. The composer's LAST
    // visible input is the TAGS field, so `nth(n-1)` put a paragraph of prose into a 32-char
    // tag box — which is a fine screenshot of the wrong thing.
    const title = frame.locator('input[type="text"]:visible').first();
    if ((await title.count()) > 0) {
      await title.fill('Does the simulated host render this legibly?', { timeout: 10_000 });
    }
    const bodyBox = frame.locator('textarea:visible').first();
    if ((await bodyBox.count()) > 0) {
      await bodyBox.fill(
        'A body long enough to show the measure. The forum caps text at max-w-[70ch]; this ' +
          'paragraph is there to prove the cap is doing something at 1280px and that nothing ' +
          'pushes a 375px page into horizontal scroll. It also fills the character counter, ' +
          'which is otherwise a screenshot of the number zero.',
        { timeout: 10_000 },
      );
    }
    await frame.waitForTimeout(400);
    await plaza.shot(`${prefix}-2-composer`);
    // Close it again: an open modal swallows every later click.
    const cancel = frame.getByRole('button', { name: /^(CANCEL|CLOSE|×)/i }).first();
    if ((await cancel.count()) > 0 && (await cancel.isVisible())) {
      await cancel.click({ timeout: 10_000 });
    } else {
      await frame.press('body', 'Escape');
    }
    await frame.waitForTimeout(600);
  } else {
    console.log(`[tour ${prefix}] no visible "+ NEW THREAD" — composer not captured`);
  }
  });

  // Settings — also where the diagnostics table, DEBUG / IDENTITY and RECENT ERRORS live.
  // ⚠️ EARLY IN THE TOUR ON PURPOSE. The steps below depend on chain data having loaded and on
  // navigation state; settings depends on neither, so it is the surface least likely to be lost
  // when a public RPC is slow. Order the tour by "how sure am I of getting this one".
  await step(`${prefix}-3-settings`, async () => {
    await clickNav(frame, /Settings/i);
    await plaza.shot(`${prefix}-3-settings`);
    // Settings is long; the interesting half is below the fold on a phone. The app scrolls in
    // `overflow-y-auto` containers, not on `window`, so scroll the tallest scrollable element
    // rather than calling `window.scrollTo` (which does nothing here and looks like a bug).
    await frame.evaluate(() => {
      const scrollable = [...document.querySelectorAll<HTMLElement>('*')]
        .filter((el) => el.scrollHeight - el.clientHeight > 40)
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      (scrollable ?? document.documentElement).scrollTop = 10_000;
    });
    await frame.waitForTimeout(300);
    await plaza.shot(`${prefix}-4-settings-scrolled`);
  });

  // The signed-in user's own profile — the `@ …` row at the top of the nav.
  // ⚠️ OPEN THE DRAWER BEFORE COUNTING. `getByRole` resolves against the accessibility tree,
  // which excludes `display:none` — and below `xl` the whole nav is `hidden`. Counting first
  // reports 0 and silently skips the shot on exactly the viewport that needed it.
  await step(`${prefix}-5-profile`, async () => {
    await openNav(frame);
    const me = frame.getByRole('button', { name: /^@/ }).first();
    if ((await me.count()) > 0) {
      await me.click({ timeout: 15_000 });
      await frame.waitForTimeout(1500);
      await plaza.shot(`${prefix}-5-profile`);
    } else {
      console.log(`[tour ${prefix}] no "@ …" nav row — profile not captured (no account?)`);
    }
  });

  // The thread detail. `ThreadCard`'s title is the app's primary navigation affordance.
  await step(`${prefix}-6-thread`, async () => {
    await clickNav(frame, FORUM);
    // ⚠️ POLL. Leaving the board and coming back re-runs `getHeadsPaged` + `walkChain` from
    // scratch — there is no list cache — so the cards are gone for several seconds every time.
    // A fixed 2 s wait here silently produced "empty board" on a board that has two threads.
    const card = frame.locator('h3').first();
    for (let i = 0; i < 40 && (await card.count()) === 0; i++) await frame.waitForTimeout(1_000);
    if ((await card.count()) > 0) {
      await card.click({ timeout: 15_000 });
      await frame.waitForTimeout(1500);
      await plaza.shot(`${prefix}-6-thread`);
    } else {
      console.log(`[tour ${prefix}] no thread cards — detail pane not captured (empty board)`);
    }
  });

  // The nav drawer itself, which at 375px has never been seen open.
  await step(`${prefix}-7-nav-drawer`, async () => {
    await clickNav(frame, FORUM);
    if (await openNav(frame)) await plaza.shot(`${prefix}-7-nav-drawer`);
  });
}

test.describe('screenshots', () => {
  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    test(`REAL host + REAL chain at ${viewport.width}px (${label})`, async ({ testHost, plaza }) => {
      // Seven surfaces, each of which may sit through a fresh chain walk. The budget is
      // generous on purpose: hitting it costs the teardown and the last images with it.
      test.setTimeout(480_000);
      const frame = await plaza.open('', viewport);
      await testHost.waitForConnection(60_000);
      // The first contract read pays for ~880 kB of Asset Hub metadata over the proxied RPC and
      // the board then walks two real chains, so wait for the board to SETTLE rather than for a
      // fixed number of seconds — a public RPC's latency is not a constant.
      // ⚠️ A POLL, NOT `waitForFunction`. `waitForFunction(() => …document.body.innerText…)`
      // re-reads the whole rendered text on every animation frame and OOM-killed the Playwright
      // worker here (`code=134`, heap limit) after ~8 minutes. Polling from the Node side once a
      // second costs nothing.
      let loaded = false;
      for (let i = 0; i < 90 && !loaded; i++) {
        loaded = (await frame.locator('h3').count()) > 0;
        if (!loaded) await frame.waitForTimeout(1_000);
      }
      if (!loaded) console.log('no thread cards after 90 s — capturing whatever is on screen');
      await frame.waitForTimeout(3_000);

      expect(await frame.locator('body').innerText()).toContain('PLAZA');
      await tour(plaza, frame, `host-${label}`);
      console.log(`host screenshots (${label}) → ${SCREENSHOT_DIR}`);
    });

    test(`fake backend, empty state at ${viewport.width}px (${label})`, async ({ plaza }) => {
      const frame = await plaza.open(FAKE, viewport);
      await frame.waitForTimeout(2500);
      await tour(plaza, frame, `fake-${label}`);
      console.log(`fake screenshots (${label}) → ${SCREENSHOT_DIR}`);
    });
  }
});
