import { useEffect, useRef, useState } from 'react';

const TWEEN_MS = 450;

/**
 * Eases a number toward its newest value (a count that rolls instead of jumping). With `animate` false (reduced motion,
 * or a hidden tab) it returns the target at once, and nothing is scheduled.
 */
export function useAnimatedNumber(target: number, animate: boolean): number {
  // The value on screen right now; moves toward `target` frame by frame while a tween runs.
  const [shown, setShown] = useState(target);
  // Where the running tween started from, so an interrupted tween continues from what the user saw.
  const shownRef = useRef(target);

  useEffect(() => {
    if (!animate || shownRef.current === target) {
      shownRef.current = target;
      setShown(target);
      return undefined;
    }
    const from = shownRef.current;
    const startedAt = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / TWEEN_MS);
      const eased = 1 - (1 - progress) ** 3;
      const value = from + (target - from) * eased;
      shownRef.current = value;
      setShown(value);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, animate]);

  return shown;
}
