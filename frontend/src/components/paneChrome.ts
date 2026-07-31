/**
 * Chrome shared by the two panes of the forum's master–detail layout.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS: THE HEADER RULE IS ONE LINE DRAWN BY TWO COMPONENTS.
 *
 * At `xl` and up the forum renders `ForumView`'s list column beside `ThreadDetailView`, each with
 * its own header ending in a `border-b`. To the eye those two borders are a SINGLE horizontal rule
 * running across the app. Nothing in the markup said so, and they drifted:
 *
 *   · the list header's tallest child is `[FORUM]` at `text-lg` — a 28px line box;
 *   · the detail header's tallest child is the COPY LINK button at `text-sm px-2 py-0.5` — ~26px.
 *
 * Both headers carried the identical `px-4 py-3 border-b border-primary-700`, so the classes looked
 * like they matched and a reader would not suspect a problem. But the height was CONTENT-DRIVEN, so
 * a 2px difference in the tallest child moved one border 2px away from the other. Reported from a
 * real device as "the horizontal line between the forum listing and the thread detail page is not
 * aligning". [V] cause; the 2px figure is [I], read off the Tailwind class semantics rather than
 * measured in a browser.
 *
 * ⚠️ So DO NOT "fix" a future misalignment by adjusting padding on one side. That restores the
 * appearance while leaving the coupling implicit, and the next change to either header's font size
 * breaks it again. Both headers take their height from `min-h` HERE, and content no longer votes.
 *
 * `min-h` rather than a fixed `h`: the detail header is `flex-wrap` and genuinely may wrap to two
 * lines on a narrow viewport, where a hard height would clip it. Wrapping costs nothing in
 * alignment terms because below `xl` the two panes are never on screen together — the list column
 * is `hidden xl:flex` once a thread is open, so there is no second border to line up with.
 *
 * `shrink-0` because both headers sit in an `h-full` flex column above a scrolling region; without
 * it a long thread compresses the header and, again, only on one side.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
export const PANE_HEADER =
  'shrink-0 min-h-14 px-4 py-3 border-b border-primary-700 flex items-center'
