export function truncateAddress(address: string): string {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Format an epoch timestamp in **MILLISECONDS**.
 *
 * ⚠️ IT USED TO TAKE SECONDS AND MULTIPLY BY 1000. That was right when every timestamp came from a
 * Solidity `block.timestamp`; it is wrong now, and it failed loudly enough to be caught only because
 * the number is absurd — the first real thread rendered as **58548-06-08**, i.e. epoch-ms fed to a
 * seconds formatter.
 *
 * The migrated data layer is milliseconds throughout: `lib/wire.ts` stores `t` as epoch ms, and
 * `PostRegistry.HeadRef.movedAt` is converted at the hook boundary (`movedAt * 1000`). Callers still
 * holding a Solidity seconds value must convert AT THE CALL SITE, visibly — a formatter that guesses
 * the unit from the magnitude would be right until the day it was not.
 */
export function formatTimestamp(epochMs: number): string {
  const date = new Date(epochMs);

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function formatBalance(balance: bigint, decimals = 18, displayDecimals = 4): string {
  const divisor = 10n ** BigInt(decimals);
  const integerPart = balance / divisor;
  const fractionalPart = balance % divisor;

  const fractionalStr = fractionalPart.toString().padStart(decimals, '0').slice(0, displayDecimals);

  return `${integerPart}.${fractionalStr}`;
}

export function getFuelStatus(balance: bigint): 'high' | 'medium' | 'low' {
  const HIGH_THRESHOLD = 10_000_000_000_000_000n;  // 0.01 PAS
  const LOW_THRESHOLD = 1_000_000_000_000_000n;    // 0.001 PAS

  if (balance >= HIGH_THRESHOLD) return 'high';
  if (balance >= LOW_THRESHOLD) return 'medium';
  return 'low';
}

export function getFuelEmoji(balance: bigint): string {
  const status = getFuelStatus(balance);
  return {
    high: '🟢',
    medium: '🟡',
    low: '🔴',
  }[status];
}
