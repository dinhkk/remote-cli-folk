import { useEffect, useState } from 'react';

/**
 * The server's clock, refreshed every second while `active`: this browser's time plus the offset measured at the last
 * answer. The running timers use it, so a clock that is a few seconds off (a Remote-style setup) does not skew them, and
 * the timers tick every second even though the server only reports changes when an agent reports progress.
 */
export function useServerNow(clockOffsetMs: number, active: boolean): number {
  // This browser's clock as of the last tick; the interval below is the only thing that moves it.
  const [localNow, setLocalNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setLocalNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  return localNow + clockOffsetMs;
}
