import { useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { reportError } from '../lib/reportError';

interface NewPostFormProps {
  onSubmit: (content: string) => Promise<number>;
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
}

export function NewPostForm({
  onSubmit,
  disabled = false,
  placeholder = '[ENTER YOUR POST]',
  maxLength = 40000,
}: NewPostFormProps) {
  const [content, setContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!content.trim() || disabled || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onSubmit(content);
      setContent('');
      toast.success('Post created!');
    } catch (error) {
      console.error('Failed to create post:', error);
      reportError('create post', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-black border-2 border-primary-500 p-4">
      <div className="relative">
        <span className="absolute left-3 top-3 text-primary-500 font-mono text-sm">
          &gt;
        </span>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={disabled ? '[POSTING UNAVAILABLE]' : placeholder}
          disabled={disabled || isSubmitting}
          className="w-full min-h-[100px] pl-8 pr-4 py-3 bg-black border-2 border-primary-600 text-primary-400 font-mono text-sm focus:outline-none focus:border-primary-400 disabled:border-gray-700 disabled:text-gray-600 disabled:shadow-none placeholder-primary-800 transition-all resize-y"
          maxLength={maxLength}
        />
      </div>

      <div className="mt-3 flex justify-between items-center">
        <span className={`font-mono text-xs ${content.length > maxLength - 100 ? 'text-red-500' : 'text-primary-600'}`}>
          {content.length.toLocaleString()}/{maxLength.toLocaleString()} CHARS
        </span>

        <button
          type="submit"
          disabled={disabled || isSubmitting || !content.trim()}
          className="bg-primary-900 hover:bg-primary-800 disabled:bg-gray-900 text-primary-400 disabled:text-gray-700 font-mono text-sm px-6 py-2 border-2 border-primary-500 hover:border-primary-400 disabled:border-gray-700 disabled:shadow-none transition-all uppercase tracking-wider font-bold shadow-neon-button"
        >
          {isSubmitting ? (
            <span className="flex items-center gap-2">
              <span className="terminal-cursor">|</span>
              POSTING
            </span>
          ) : (
            '+ POST'
          )}
        </button>
      </div>
    </form>
  );
}
