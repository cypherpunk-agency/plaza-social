// DEBUG / IDENTITY — the instrument, not the conclusion.
//
// ⭐ WHY THIS SCREEN EXISTS. One human, two devices, two different product accounts. Three
// explanations were proposed and all three were rejected. The right move at that point is not a
// fourth theory: it is to put every input of the account derivation in front of the person who has
// both devices, and let them read the values back. So this panel asserts NOTHING. It shows what the
// host handed over, what we asked the host for, what the page actually is, and — just as
// importantly — which facts are not obtainable and why.
//
// ⛔ IT IS READ-ONLY, AND THAT IS A CONTRACT, NOT AN ASPIRATION.
//
// Rendering this panel performs ZERO host calls. It reads a record `session.ts` filled during the
// handshake it was already running (`lib/host/identity.ts`) plus a handful of browser globals. It
// cannot sign, cannot submit, cannot request an allowance and cannot prompt — which is what makes it
// safe to open on a device in the middle of a broken session, the only moment it is useful.
//
// ⛔ AND IT NEVER DERIVES AN ACCOUNT. No h160 → AccountId32, in any direction, for any reason.
// `Revive.OriginalAccount` is the only sound route and it lives in `session.ts`. Breaking that rule
// loses real money — measured: the derivation gives a DIFFERENT account nobody holds a key for.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ⚠️ THE VALUES HERE ARE READ OFF A PHONE SCREEN AND TYPED INTO A CHAT.
//
// Two consequences that outrank house style:
//
//   1. **COPY ALL is the most valuable control on the screen**, so it is first, it is a real
//      `<button>`, and what it produces is one plain-text block — one `key: value` per line, ASCII
//      only, no colour, nothing truncated. A SHOW TEXT toggle reveals the same block selectable, for
//      the case where the clipboard is refused (`Clipboard` is a host DEVICE permission and a missing
//      one fails SILENTLY — see `lib/clipboard.ts`).
//   2. **Legibility beats subtlety.** The boot console is muted because it is background texture;
//      this is the subject. Values render in `primary-300`, the brightest declared shade, because a
//      mistyped SS58 character costs an investigation.
//
// ⚠️ EVERY COLOUR CLASS HERE IS A SHADE DECLARED IN THE `@theme static` BLOCK IN `index.css`
// (`primary-300…700`, `accent-400`, stock `yellow-500`/`red-400`). A colour Tailwind has not been
// told about generates NO CSS AT ALL, silently. Nothing new was invented for this file.
//
// ⚠️ `wrap-anywhere`, NEVER `break-words`. `overflow-wrap: break-word` does not reduce a box's
// MIN-CONTENT width, so a 48-character SS58 address forced the forum column to 406.8px on a 375px
// viewport — ~32px of the app off-screen, clipped by an ancestor `overflow-hidden` so
// `document.scrollWidth` still read 375 and it did not present as a scroll bug. This panel is made
// almost entirely of long hex and SS58 runs. Not `break-all` either: that chops prose mid-word, and
// most of an `unavailable` reason is a sentence.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import type { Capabilities, DiagnosticStep } from '../lib/host';
// Deeper than the barrel, for the same reason `SettingsView` imports `lib/host/errors` deeply:
// `lib/host/index.ts` is owned elsewhere and does not export this yet. `identity.ts` is pure — it
// imports no `@parity/*` and calls no host — so the rule it bends costs nothing here.
import {
  buildIdentityReport,
  emptyEnvironment,
  formatIdentityReport,
  subscribeHostIdentity,
  type HostIdentitySnapshot,
  type IdentitySection,
  type PageEnvironment,
} from '../lib/host/identity';
import { copyTextVerified } from '../lib/clipboard';
// ⚠️ THE DECLARED RANGES, NOT THE RESOLVED VERSIONS, and the panel says so. No `@parity` package
// exports a runtime version constant, and nothing at runtime can see `node_modules`. `?raw` keeps
// this a string parse rather than a JSON module import, which `tsconfig.app.json` does not enable.
import packageJsonRaw from '../../package.json?raw';

/**
 * Everything about the page that is knowable without asking the host.
 *
 * ⚠️ EVERY READ IS GUARDED. This runs inside a sandboxed iframe on a phone; `localStorage` can throw
 * outright, `ancestorOrigins` does not exist outside Chromium, and `window.top` access across an
 * origin boundary throws in some engines. A thrown getter here would blank the one screen somebody
 * opened because everything else was already broken.
 */
function readPageEnvironment(dappName: string | null): PageEnvironment {
  const env = emptyEnvironment();

  try {
    const loc = globalThis.location;
    if (loc) {
      env.hostname = loc.hostname || null;
      env.origin = loc.origin || null;
      env.href = loc.href || null;
      // The same value `lib/host/container.ts` `productIdentifier()` returns — it IS
      // `location.hostname`. Recomputed rather than imported so this file does not reach into the
      // host layer for a string it already has, and the panel labels it with that provenance.
      env.containerProductIdentifier = loc.hostname || null;
      try {
        const list = loc.ancestorOrigins;
        if (list) env.ancestorOrigins = Array.from({ length: list.length }, (_, i) => list[i]);
      } catch {
        /* Chromium-only; absent elsewhere, which the panel reports rather than hides. */
      }
    }
  } catch {
    /* ignore — location is unreadable, and the fields stay null */
  }

  try {
    env.inIframe = globalThis.window ? globalThis.window.top !== globalThis.window.self : null;
  } catch {
    // A cross-origin `window.top` access can throw — which is itself the answer.
    env.inIframe = true;
  }

  try {
    env.referrer = globalThis.document?.referrer || null;
  } catch {
    /* ignore */
  }

  try {
    env.userAgent = globalThis.navigator?.userAgent || null;
  } catch {
    /* ignore */
  }

  // The built chunk's own URL. On a Bulletin-served build the bundle CID sits in this path, so it
  // identifies WHICH BUILD produced the readings below — the one thing a pasted block otherwise
  // cannot tell us.
  try {
    env.moduleUrl = import.meta.url || null;
  } catch {
    /* ignore */
  }

  try {
    env.buildMode = import.meta.env?.MODE ?? null;
  } catch {
    /* ignore */
  }

  try {
    const store = globalThis.localStorage;
    if (store) {
      const keys: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key !== null) keys.push(key);
      }
      keys.sort();
      env.localStorageKeys = keys;

      /**
       * ⭐ THE ONE VALUE WORTH DISCLOSING, AND IT IS DISCLOSED ON PURPOSE.
       *
       * `product-sdk:signer:{dappName}:selectedAccount` is where the SDK persists the account THIS
       * browser profile last selected. A stale entry is a concrete, checkable cause of "why is this
       * device showing a different account", and it is an address rather than a secret.
       *
       * ⛔ NO OTHER VALUE IS DUMPED. This block gets pasted into a chat, and we do not audit every
       * key some future feature might write. Names, yes; contents, no.
       */
      const exact = dappName ? `product-sdk:signer:${dappName}:selectedAccount` : null;
      const match =
        (exact && keys.includes(exact) ? exact : null) ??
        keys.find((k) => k.startsWith('product-sdk:signer:') && k.endsWith(':selectedAccount')) ??
        null;
      if (match) {
        const stored = store.getItem(match);
        env.persistedSelectedAccount = stored ? `${match} = ${stored}` : null;
      }
    }
  } catch {
    /* localStorage can be denied outright inside a sandboxed frame */
  }

  try {
    const parsed = JSON.parse(packageJsonRaw) as { dependencies?: Record<string, string> };
    const deps = parsed.dependencies ?? {};
    env.sdkRanges = Object.keys(deps)
      .filter((name) => name.startsWith('@parity/'))
      .sort()
      .map((name) => [name, deps[name]] as [string, string]);
  } catch {
    /* ignore — the panel reports the absence */
  }

  return env;
}

export interface IdentityDebugPanelProps {
  /** `HostSession.label`. Also how the panel tells a fake backend from a real one. */
  backendLabel: string;
  capabilities: Capabilities;
  /**
   * Included in COPY ALL so one paste carries the whole picture. Rendered separately by the
   * DIAGNOSTICS panel above; this is not a second copy of that view, only of its text.
   */
  diagnostics: DiagnosticStep[];
}

export function IdentityDebugPanel({
  backendLabel,
  capabilities,
  diagnostics,
}: IdentityDebugPanelProps) {
  // Subscribed rather than read once: `session.ts` republishes as each fact lands, so a panel opened
  // during a slow handshake fills in rather than freezing on whatever was true when it mounted.
  const [snapshot, setSnapshot] = useState<HostIdentitySnapshot | null>(null);
  useEffect(() => subscribeHostIdentity(setSnapshot), []);

  const [showText, setShowText] = useState(false);

  const environment = useMemo(
    () => readPageEnvironment(snapshot?.dappName ?? null),
    [snapshot?.dappName],
  );

  const sections: IdentitySection[] = useMemo(
    () =>
      buildIdentityReport({
        snapshot,
        environment,
        backendLabel,
        capabilityAddress: capabilities.address,
        capabilityInsideHost: capabilities.insideHost,
      }),
    [snapshot, environment, backendLabel, capabilities.address, capabilities.insideHost],
  );

  /**
   * ⚠️ `generatedAt` IS STATE, NOT `Date.now()` IN THE RENDER BODY. A clock read during render is an
   * impure call — the lint rule catches it, and the reason it is right here is not stylistic: the
   * header line has to say when the block a person is about to paste was produced, and a value that
   * silently changes on every unrelated re-render is not that. It is stamped at mount and re-stamped
   * whenever the user actually asks for the text.
   */
  const [generatedAt, setGeneratedAt] = useState(() => Date.now());

  const buildText = useMemo(
    () => (at: number) =>
      formatIdentityReport(sections, {
        generatedAt: at,
        // Rebuilt on every diagnostics emit on purpose: COPY ALL must carry the record as it stands
        // when the button is pressed, not as it stood when the panel mounted.
        diagnostics: diagnostics.map((step) => ({
          id: step.id,
          status: step.status,
          detail: step.detail,
        })),
      }),
    [sections, diagnostics],
  );

  const plainText = useMemo(() => buildText(generatedAt), [buildText, generatedAt]);

  const handleCopy = async () => {
    // Stamped fresh, and the same value is used for the copy AND for the visible block, so the two
    // can never disagree about when they were produced.
    const at = Date.now();
    setGeneratedAt(at);
    // `copyTextVerified`, not `copyText`: inside the host `Clipboard` is a DEVICE permission and a
    // missing one fails silently, so a resolved promise is not evidence. Three outcomes, three
    // sentences — and `unverified` is the NORMAL desktop answer, so it is worded calmly rather than
    // as an alarm.
    const outcome = await copyTextVerified(buildText(at));
    if (outcome === 'copied') {
      toast.success('Copied.');
      return;
    }
    if (outcome === 'unverified') {
      toast('Copied — but the clipboard could not be read back to confirm it. Use SHOW TEXT if the paste comes up empty.', {
        icon: 'i',
        duration: 8000,
      });
      setShowText(true);
      return;
    }
    toast.error('The clipboard refused. SHOW TEXT is open below — select it and copy by hand.');
    setShowText(true);
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-bold text-accent-400 font-mono">
          DEBUG / IDENTITY{' '}
          <span className="text-primary-600 text-xs">(read-only — nothing here signs or prompts)</span>
        </h3>
        <div className="flex gap-2 shrink-0">
          <button
            type="button"
            onClick={handleCopy}
            className="px-3 py-1 text-xs font-mono text-primary-400 border border-primary-600 hover:border-primary-400 hover:text-primary-300 transition-colors"
          >
            COPY ALL
          </button>
          <button
            type="button"
            onClick={() => {
              // Re-stamp on OPEN only: closing the block does not produce a new one.
              if (!showText) setGeneratedAt(Date.now());
              setShowText((open) => !open);
            }}
            aria-expanded={showText}
            className="px-3 py-1 text-xs font-mono text-primary-500 border border-primary-700 hover:border-primary-500 transition-colors"
          >
            {showText ? 'HIDE TEXT' : 'SHOW TEXT'}
          </button>
        </div>
      </div>

      <div className="border border-primary-700 p-4 font-mono space-y-4 min-w-0">
        <p className="text-[11px] leading-relaxed text-primary-500 wrap-anywhere">
          Open this on both devices and compare. Start with{' '}
          <span className="text-primary-300">account.primaryUsername</span>: the same username on both
          means one identity and a pairing problem; different usernames mean two identities. Then
          compare <span className="text-primary-300">account.publicKey</span> and{' '}
          <span className="text-primary-300">asked.productIdentifier</span>.
        </p>

        {sections.map((section) => (
          <div key={section.title} className="space-y-1 min-w-0">
            <h4 className="text-[11px] font-bold text-accent-400">{section.title}</h4>
            {section.note && (
              <p className="text-[11px] leading-snug text-primary-600 wrap-anywhere">{section.note}</p>
            )}
            {section.fields.map((field) => (
              <div key={field.key} className="text-[11px] leading-snug min-w-0 wrap-anywhere">
                <span className="text-primary-500">{field.key}: </span>
                {field.value.status === 'value' ? (
                  // Selectable on purpose: on a phone the clipboard may be refused entirely, and
                  // reading one field off the screen is the fallback that always works.
                  <span className="text-primary-300 select-text">{field.value.value}</span>
                ) : (
                  <span className="text-yellow-500">
                    unavailable — {field.value.reason}
                  </span>
                )}
                {/* `pl-4`: the source hangs under the value rather than under the key, so a scan
                    down the left edge reads keys only. Dimmer than the value, brighter than the
                    boot console's detail text — it is reference, but it still gets transcribed. */}
                <div className="pl-4 text-primary-600 wrap-anywhere">{field.source}</div>
              </div>
            ))}
          </div>
        ))}

        {showText && (
          // The same bytes COPY ALL produces. `select-text` and `whitespace-pre-wrap` so it can be
          // dragged out by hand when the clipboard is refused, which is the case this exists for.
          <pre className="mt-2 text-[11px] leading-snug whitespace-pre-wrap wrap-anywhere text-primary-400 select-text border-t border-primary-800 pt-2">
            {plainText}
          </pre>
        )}
      </div>
    </div>
  );
}
