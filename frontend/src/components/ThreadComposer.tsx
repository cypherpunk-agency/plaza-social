import { useState } from 'react';
import { PANE_HEADER } from './paneChrome';
import { reportError } from '../lib/reportError';

interface ThreadComposerProps {
  /**
   * Publishes the thread. MUST REJECT on failure — that is the whole error contract here.
   *
   * The composer keeps the draft on screen when this rejects, so a failed publish never costs the
   * user their text. On resolve the parent is expected to close the composer, which unmounts this
   * component and takes the draft with it; see the CANCEL comment below for why that is the intended
   * lifetime rather than an accident.
   */
  onCreate: (title: string, content: string, tags: string[]) => Promise<void>;
  /** Close the composer without publishing. Discards the draft — see the comment on CANCEL. */
  onCancel: () => void;
}

/**
 * The new-thread composer, as a PANE — not a strip inside the thread list.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY IT LIVES IN THE DETAIL PANE, AND WHAT IT DOES TO A SELECTED THREAD.
 *
 * It used to render inline in the list column, directly under the list header, which on a phone
 * meant a full-height form squeezed above the board it was pushing down, and at `xl` meant a form
 * in the 24rem column while a 70ch pane sat empty next to it. Reported from a device as "the new
 * thread box is opening in the thread list instead of in the detail view".
 *
 * ⚠️ THE RULE, because the composer and an open thread want the same pane:
 *
 *   1. The composer WINS the pane while it is open. `ForumView` renders it instead of
 *      `ThreadDetailView`, not beside it — two scrolling regions in one pane on a 375px screen is
 *      not a layout.
 *   2. Opening it does NOT clear the thread selection. `selectedThreadCid` is left exactly as it
 *      was, so CANCEL puts the reader back on the thread they were reading (or on the empty state
 *      if there was none). Silently discarding a selection because someone tapped + NEW THREAD is
 *      the bug this rule exists to prevent.
 *   3. A successful publish REPLACES the selection with the new thread — the author should land on
 *      what they just wrote, not on an empty pane. `ForumView` owns that: `createThread` resolves
 *      with the new announcement CID and `handleCreateThread` selects it. Exactly, not by working
 *      out which row on the board is new.
 *
 * ⚠️ CANCEL DISCARDS THE DRAFT, from BOTH controls, and that is deliberate.
 * The pre-existing inline form cleared every field on CANCEL, so this is not a behaviour change —
 * but there are now two ways out (the header control and the button under the form) and they must
 * not differ. The header control exists because below `xl` this pane is the WHOLE screen: the list
 * is `hidden`, so there is nothing to click away to and no BACK anywhere else on screen. Draft
 * state therefore lives in this component and dies with it, which is what makes the two controls
 * impossible to tell apart.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
export function ThreadComposer({ onCreate, onCancel }: ThreadComposerProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const canSubmit = !!title.trim() && !!content.trim() && !isCreating;

  const handleAddTag = () => {
    const tag = tagInput.trim().toLowerCase();
    if (tag && !tags.includes(tag) && tags.length < 5 && tag.length <= 32) {
      setTags([...tags, tag]);
      setTagInput('');
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setTags(tags.filter((t) => t !== tagToRemove));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setIsCreating(true);
    try {
      await onCreate(title, content, tags);
      // Deliberately nothing here. The parent closes the composer and selects the new thread; this
      // component is on its way to being unmounted, so clearing fields would be a write to a dead
      // component that also briefly flashes an empty form.
    } catch (error) {
      // ⚠️ NOT `toast.error('Failed to create thread')`. That sentence was the end of the trail: the
      // real cause lived only in a console nobody can open on a phone. `reportError` keeps the toast
      // short, makes it tap-to-copy, and files the detail in Settings → RECENT ERRORS.
      reportError('create thread', error);
      setIsCreating(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col h-full min-w-0">
      {/* Header. Height comes from `PANE_HEADER`, not from content — its border and the list
          column's are one continuous rule across the app and must not drift. A new pane state with
          a differently-sized header is exactly how that rule broke last time. See `paneChrome.ts`. */}
      <div className={PANE_HEADER}>
        <div className="flex items-center justify-between w-full gap-3">
          <span className="font-mono text-primary-500 text-lg">[NEW THREAD]</span>
          <button
            type="button"
            onClick={onCancel}
            disabled={isCreating}
            className="text-sm font-mono text-primary-500 hover:text-primary-400 whitespace-nowrap disabled:opacity-50"
          >
            {/* Below `xl` this button is the ONLY way out — the list column is `hidden` and the
                composer is the whole screen. At `xl` the list is still there, so it reads as
                closing a pane rather than as navigation. Same wording split as the detail view. */}
            <span className="xl:hidden">&larr; CANCEL</span>
            <span className="hidden xl:inline">&larr; CLOSE</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 min-w-0">
        {/* Capped to the same measure as the body text in the card and the detail pane. A wide pane
            is not licence for a 200-character input. */}
        <div className="max-w-[70ch] min-w-0">
          <div className="mb-3">
            <label className="block text-xs font-mono text-primary-600 mb-1">TITLE (max 200 chars)</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Thread title..."
              className="w-full px-3 py-2 bg-black border border-primary-600 text-primary-400 font-mono text-sm focus:outline-none focus:border-primary-400"
              maxLength={200}
              disabled={isCreating}
            />
          </div>

          <div className="mb-3">
            <label className="block text-xs font-mono text-primary-600 mb-1">CONTENT (max 40,000 chars)</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Thread content..."
              className="w-full min-h-[120px] px-3 py-2 bg-black border border-primary-600 text-primary-400 font-mono text-sm focus:outline-none focus:border-primary-400 resize-y"
              maxLength={40000}
              disabled={isCreating}
            />
            <div className="text-xs font-mono text-primary-600 mt-1">
              {content.length.toLocaleString()} / 40,000
            </div>
          </div>

          <div className="mb-3">
            <label className="block text-xs font-mono text-primary-600 mb-1">
              TAGS (max 5, each max 32 chars)
            </label>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  // ⚠️ `preventDefault` is load-bearing now that this is a real `<form>`: without it
                  // Enter in the tag field submits the thread instead of adding the tag.
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddTag();
                  }
                }}
                placeholder="Add a tag..."
                className="flex-1 px-3 py-2 bg-black border border-primary-600 text-primary-400 font-mono text-sm focus:outline-none focus:border-primary-400"
                maxLength={32}
                disabled={isCreating || tags.length >= 5}
              />
              <button
                type="button"
                onClick={handleAddTag}
                disabled={isCreating || tags.length >= 5 || !tagInput.trim()}
                className="px-3 py-2 text-xs font-mono text-primary-500 border border-primary-600 hover:border-primary-400 disabled:opacity-50"
              >
                ADD
              </button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs font-mono bg-primary-900 text-primary-400 border border-primary-700"
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(tag)}
                      disabled={isCreating}
                      className="text-primary-600 hover:text-primary-400"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-4 py-2 text-xs font-mono text-primary-400 border border-primary-500 hover:bg-primary-900 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isCreating ? 'CREATING...' : 'CREATE THREAD'}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={isCreating}
              className="px-4 py-2 text-xs font-mono text-primary-600 border border-primary-700 hover:border-primary-500"
            >
              CANCEL
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
