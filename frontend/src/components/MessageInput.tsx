import { useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';

interface MessageInputProps {
  onSend: (message: string) => Promise<boolean>;
  disabled: boolean;
  isSending: boolean;
  /**
   * Opens the panel that explains why posting is unavailable.
   *
   * ⚠️ Was `onConnectWallet`. There is no wallet to connect — the host container is the only surface
   * and it either grants a writable account or it does not. The composer's job when disabled is to
   * explain, not to offer an action that cannot exist.
   */
  onExplainDisabled?: () => void;
}

export function MessageInput({ onSend, disabled, isSending, onExplainDisabled }: MessageInputProps) {
  const [message, setMessage] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!message.trim() || disabled || isSending) return;

    try {
      const success = await onSend(message);

      if (success) {
        setMessage('');
      } else {
        toast.error('✖ TRANSMISSION FAILED');
      }
    } catch (error) {
      toast.error('✖ TRANSMISSION ERROR');
    }
  };

  // Clicking a disabled composer asks "why can't I type here?" — so answer that.
  const handleDisabledClick = () => {
    if (disabled && onExplainDisabled) {
      onExplainDisabled();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="border-t-2 border-primary-500 bg-black p-4">
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-primary-500 font-mono text-sm">
            &gt;
          </span>
          {disabled && onExplainDisabled ? (
            // Clickable overlay when disabled — opens the explanation, not a wallet chooser.
            <button
              type="button"
              onClick={handleDisabledClick}
              className="w-full pl-8 pr-4 py-3 bg-black border-2 border-primary-600 text-primary-600 font-mono text-sm text-left cursor-pointer hover:border-primary-500 hover:text-primary-500 transition-all"
            >
              [POSTING UNAVAILABLE — TAP FOR DETAILS]
            </button>
          ) : (
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={disabled ? '[POSTING UNAVAILABLE]' : '[ENTER MESSAGE]'}
              disabled={disabled || isSending}
              className="w-full pl-8 pr-4 py-3 bg-black border-2 border-primary-500 text-primary-400 font-mono text-sm focus:outline-none focus:border-primary-400 disabled:border-gray-700 disabled:text-gray-600 disabled:shadow-none placeholder-primary-800 transition-all shadow-neon-input"
              maxLength={500}
            />
          )}
        </div>
        <button
          type="submit"
          disabled={disabled || isSending || !message.trim()}
          className="bg-primary-900 hover:bg-primary-800 disabled:bg-gray-900 text-primary-400 disabled:text-gray-700 font-mono text-sm px-8 py-3 border-2 border-primary-500 hover:border-primary-400 disabled:border-gray-700 disabled:shadow-none transition-all uppercase tracking-wider font-bold shadow-neon-button"
        >
          {isSending ? (
            <span className="flex items-center gap-2">
              <span className="terminal-cursor">█</span>
              SENDING
            </span>
          ) : (
            '▶ SEND'
          )}
        </button>
      </div>
      <div className="mt-2 flex justify-between items-center font-mono text-xs">
        <span className="text-primary-700">
          [BLOCKCHAIN STORAGE ACTIVE]
        </span>
        <span className={`${message.length > 450 ? 'text-red-500' : 'text-primary-600'}`}>
          {message.length}/500 CHARS
        </span>
      </div>
    </form>
  );
}
