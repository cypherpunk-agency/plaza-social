/**
 * Copying text, with a result you are allowed to believe.
 *
 * ⚠️ `Clipboard` IS A HOST DEVICE PERMISSION. It sits in `HostDevicePermissionRequest` alongside
 * `Camera`, `Microphone`, `OpenUrl` and the rest
 * (`@parity/truapi` → `dist/generated/types.d.ts`: `"Notifications" | "Camera" | "Microphone" |
 * "Bluetooth" | "NFC" | "Location" | "Clipboard" | "OpenUrl" | "Biometrics"`). Inside the host
 * container a missing permission does not throw a labelled error — it fails QUIETLY, which is the
 * single most expensive trap in `gotchas.md`. `navigator.clipboard.writeText()` resolving is
 * therefore NOT evidence that anything reached the clipboard.
 *
 * So this module never reports success on the strength of a resolved promise alone. It writes, then
 * READS BACK, and distinguishes three outcomes:
 *
 *   `copied`      — read back and the bytes match. The only outcome worth a plain "Copied".
 *   `failed`      — both write paths refused, or the read-back succeeded and returned something
 *                   else. The second case is the silent failure, caught.
 *   `unverified`  — a write reported success but the clipboard could not be read back WITHOUT
 *                   prompting the user, which is the common case: `clipboard-read` is denied by
 *                   default in every browser. We do not know. Say so, and show the text.
 *
 * ⚠️ `unverified` IS THE NORMAL DESKTOP OUTCOME, not an edge case. Word it as "probably fine, here
 * is the link if not" rather than as an alarm, or the app cries wolf on every copy.
 *
 * ⛔ WHAT IS MISSING, DELIBERATELY: this does not call
 * `requestDevicePermission("Clipboard")` from `@parity/product-sdk-host` first. That import belongs
 * in `lib/host/sdk.ts` — the only module allowed to import `@parity/*` — and would have to be
 * surfaced through the host seam. Until it is, the read-back is what stands between us and an
 * optimistic "Copied!" over a clipboard that rejected.
 */

export type CopyOutcome = "copied" | "unverified" | "failed";

/** The slice of `navigator.clipboard` this needs. Injected so the outcomes can be tested. */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
  readText?(): Promise<string>;
}

export interface CopyDeps {
  clipboard: ClipboardLike | null;
  /**
   * Whether reading the clipboard back is allowed WITHOUT asking the user.
   *
   * ⚠️ THIS GUARD IS THE WHOLE REASON THE READ-BACK IS SAFE TO DO. Calling
   * `navigator.clipboard.readText()` speculatively pops Chrome's "see text and images copied to the
   * clipboard?" prompt — so a COPY button would interrogate the user about PASTING, which is both
   * confusing and a privacy ask we have no business making. We therefore query the permission state
   * and read back only when it is ALREADY `granted`; everywhere else the honest answer is
   * `unverified`, not a prompt.
   */
  canReadBack: () => Promise<boolean>;
  /**
   * The synchronous, deprecated path. It exists here for one property the async API lacks: it
   * RETURNS A BOOLEAN, so a refusal is visible rather than silent. Used as a second attempt after
   * the async write rejects.
   */
  execCopy: (text: string) => boolean;
}

function defaultClipboard(): ClipboardLike | null {
  if (typeof navigator === "undefined") return null;
  const clip = (navigator as Navigator & { clipboard?: ClipboardLike }).clipboard;
  return clip && typeof clip.writeText === "function" ? clip : null;
}

async function defaultCanReadBack(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.permissions) return false;
  try {
    // `clipboard-read` is not in every lib.dom PermissionName union; the query is guarded anyway.
    const status = await navigator.permissions.query({
      name: "clipboard-read" as PermissionName,
    });
    return status.state === "granted";
  } catch {
    // Firefox throws on an unknown permission name. Unknown ⇒ do not read ⇒ do not prompt.
    return false;
  }
}

function defaultExecCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  // Off-screen but focusable. `display:none` would make the selection un-copyable.
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/**
 * Write `text` to the clipboard and report what actually happened.
 *
 * Never throws: the caller's job is to render the outcome, and an exception here would just become
 * another catch block that reports "copied" by omission.
 */
export async function copyTextVerified(
  text: string,
  deps: Partial<CopyDeps> = {},
): Promise<CopyOutcome> {
  const clipboard = deps.clipboard !== undefined ? deps.clipboard : defaultClipboard();
  const canReadBack = deps.canReadBack ?? defaultCanReadBack;
  const execCopy = deps.execCopy ?? defaultExecCopy;

  let wrote = false;
  if (clipboard && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text);
      wrote = true;
    } catch {
      wrote = false;
    }
  }

  // Second, independent attempt. Its boolean is a real refusal signal, which is more than the async
  // API gives us — inside the host a denied `Clipboard` permission can resolve the promise anyway.
  if (!wrote) {
    wrote = execCopy(text);
    if (!wrote) return "failed";
  }

  if (typeof clipboard?.readText !== "function") return "unverified";
  if (!(await canReadBack())) return "unverified";

  let readBack: string;
  try {
    readBack = await clipboard.readText();
  } catch {
    // Read permission is a separate grant from write. A denied read tells us nothing about the write.
    return "unverified";
  }

  // The write reported success and the clipboard holds something else: it did not take. This is the
  // failure mode a "Copied!" toast would have hidden.
  return readBack === text ? "copied" : "failed";
}
