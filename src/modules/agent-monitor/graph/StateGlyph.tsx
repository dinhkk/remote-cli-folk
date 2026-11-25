import { STATE_STYLE } from '@/modules/agent-monitor/graph/stateStyle';
import type { AgentMonitorState } from '@/shared/types';

/** The glyph at the left of a box: a spinning arc while running, a pause mark when waiting, a check, a cross or a square. */
export function StateGlyph({ state, animate }: { state: AgentMonitorState; animate: boolean }) {
  const style = STATE_STYLE[state];
  const spin = animate && state === 'running' ? 'monitor-spin' : '';
  const blink = animate && state === 'waiting' ? 'monitor-blink' : '';
  return (
    <svg viewBox="-8 -8 16 16" width="16" height="16" className="shrink-0" aria-hidden="true" data-state-glyph={state}>
      {state === 'running' && (
        <>
          <circle r="6" fill="none" className="stroke-blue-500/25" strokeWidth="2" />
          <circle r="6" fill="none" className={`${style.stroke} ${spin}`} strokeWidth="2" strokeDasharray="10 28" strokeLinecap="round" />
        </>
      )}
      {state === 'waiting' && (
        <g className={blink}>
          <rect x="-4" y="-5" width="3" height="10" rx="1" className={style.fill} />
          <rect x="1" y="-5" width="3" height="10" rx="1" className={style.fill} />
        </g>
      )}
      {state === 'done' && <path d="M-5 0 L-1.5 3.5 L5 -4" fill="none" className={style.stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />}
      {state === 'failed' && <path d="M-4 -4 L4 4 M4 -4 L-4 4" fill="none" className={style.stroke} strokeWidth="2.2" strokeLinecap="round" />}
      {state === 'stopped' && <rect x="-4" y="-4" width="8" height="8" rx="1.5" className={style.fill} />}
    </svg>
  );
}
