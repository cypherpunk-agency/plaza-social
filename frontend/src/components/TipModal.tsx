import { useState } from 'react';
import { ethers } from 'ethers';
import toast from 'react-hot-toast';
import { truncateAddress, formatBalance } from '../utils/formatters';
import type { Signer } from '../utils/contracts';

// The BROWSER-WALLET ARM IS GONE (architecture.md §1: the host container is the only surface).
// What is left is one option, the posting key, so the picker below collapses to a single row.
// The `WalletOption[]` shape is kept rather than flattened because a second option is coming back:
// once the host arm can submit (see `lib/host/types.ts`, `SignerSeam.host.submit`), "tip from your
// own account, with a prompt" belongs beside "tip from the posting key, prompt-free".
interface WalletOption {
  id: 'session';
  label: string;
  address: string;
  signer: Signer | null;
  balance: bigint;
}

interface TipModalProps {
  isOpen: boolean;
  onClose: () => void;
  recipientAddress: string;
  recipientName?: string;
  /** The posting key (delegate). Prompt-free, which is why it is the tipping account. */
  sessionWallet?: Signer | null;
  sessionWalletAddress?: string | null;
  sessionWalletBalance?: bigint;
  /** Opens the host notice when there is nothing to tip from. */
  onConnectWallet?: () => void;
}

export function TipModal({
  isOpen,
  onClose,
  recipientAddress,
  recipientName,
  sessionWallet,
  sessionWalletAddress,
  sessionWalletBalance = 0n,
  onConnectWallet,
}: TipModalProps) {
  const [amount, setAmount] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One option: the posting key. The browser-wallet entry and the `useEffect` that fetched its
  // balance and signer out of `provider.getSigner()` are gone with the MetaMask path.
  const walletOptions: WalletOption[] = [];

  if (sessionWalletAddress && sessionWallet) {
    walletOptions.push({
      id: 'session',
      label: 'Posting Key',
      address: sessionWalletAddress,
      signer: sessionWallet,
      balance: sessionWalletBalance,
    });
  }

  const selectedOption = walletOptions[0];
  const canSend = walletOptions.length > 0 && selectedOption;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amount.trim() || !canSend || !selectedOption) return;

    setError(null);
    setIsLoading(true);

    try {
      // Validate amount
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        throw new Error('Please enter a valid amount greater than 0');
      }

      const tipValue = ethers.parseEther(amount);

      // Check balance
      if (tipValue > selectedOption.balance) {
        throw new Error('Insufficient balance in selected wallet');
      }

      const activeSigner = selectedOption.signer;
      if (!activeSigner) {
        throw new Error('No wallet available to sign transaction');
      }

      // Send the tip
      const tx = await activeSigner.sendTransaction({
        to: recipientAddress,
        value: tipValue,
      });

      toast.loading('Sending tip...', { id: 'tip' });
      await tx.wait();

      toast.success(`Sent ${amount} PAS to ${recipientName || truncateAddress(recipientAddress)}!`, { id: 'tip' });
      setAmount('');
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send tip';
      setError(message);
      toast.error(message, { id: 'tip' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    if (!isLoading) {
      setAmount('');
      setError(null);
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/75"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-sm mx-4 border-2 border-yellow-500 bg-black">
        {/* Header */}
        <div className="border-b-2 border-yellow-500 px-6 py-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-yellow-500 font-mono">
            SEND TIP
          </h2>
          <button
            onClick={handleClose}
            disabled={isLoading}
            className="text-yellow-500 hover:text-yellow-400 text-2xl font-mono disabled:opacity-50"
          >
            ×
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Recipient */}
          <div>
            <label className="block text-primary-600 font-mono text-xs mb-2">
              SENDING TO
            </label>
            <div className="p-3 border border-primary-700 bg-primary-950">
              <div className="text-primary-300 font-mono text-sm">
                {recipientName || 'Unknown User'}
              </div>
              <div className="text-primary-600 font-mono text-xs mt-1">
                {truncateAddress(recipientAddress)}
              </div>
            </div>
          </div>

          {/* Single wallet display */}
          {walletOptions.length === 1 && selectedOption && (
            <div>
              <label className="block text-primary-600 font-mono text-xs mb-2">
                PAY FROM
              </label>
              <div className="p-3 border border-primary-700 bg-primary-950">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-primary-300 font-mono text-sm">
                      {selectedOption.label}
                    </div>
                    <div className="text-primary-600 font-mono text-xs mt-0.5">
                      {truncateAddress(selectedOption.address)}
                    </div>
                  </div>
                  <div className="text-primary-400 font-mono text-sm">
                    {formatBalance(selectedOption.balance)} PAS
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* No wallet connected */}
          {walletOptions.length === 0 && (
            <div className="text-center py-4">
              <p className="text-primary-400 font-mono text-sm mb-4">
                Tipping needs a posting key, which needs the Polkadot app
              </p>
              {onConnectWallet && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onConnectWallet();
                  }}
                  className="px-6 py-2 border-2 border-yellow-500 bg-yellow-950 text-yellow-500 font-mono text-sm hover:bg-yellow-900 transition-colors"
                >
                  WHY NOT?
                </button>
              )}
            </div>
          )}

          {/* Amount - only show when wallet available */}
          {walletOptions.length > 0 && <div>
            <label className="block text-primary-600 font-mono text-xs mb-2">
              AMOUNT
            </label>
            <div className="flex items-center gap-2">
              <div className="flex-1 relative">
                <input
                  type="text"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.0"
                  disabled={isLoading}
                  className="w-full bg-black border-2 border-yellow-700 px-4 py-3 text-yellow-400 font-mono text-sm placeholder-yellow-900 focus:outline-none focus:border-yellow-500 disabled:opacity-50 text-right pr-14"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-yellow-600 font-mono text-sm pointer-events-none">
                  PAS
                </span>
              </div>
            </div>
          </div>}

          {error && (
            <div className="p-3 border border-red-500 bg-red-950/20">
              <p className="text-red-400 font-mono text-sm">{error}</p>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={isLoading}
              className="flex-1 py-3 border-2 border-gray-600 text-gray-400 font-mono text-sm hover:border-gray-500 transition-colors disabled:opacity-50"
            >
              CANCEL
            </button>
            <button
              type="submit"
              disabled={isLoading || !amount.trim() || !canSend}
              className="flex-1 py-3 border-2 border-yellow-500 bg-yellow-950 text-yellow-500 font-mono text-sm hover:bg-yellow-900 transition-colors disabled:opacity-50"
            >
              {isLoading ? 'SENDING...' : 'SEND TIP'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
