import { memo, useMemo } from 'react';

import {
  formatFullTimestampTooltip,
  formatMessageTimestamp,
} from '@/modules/chat/utils/chatFormatting';

type MessageTimeProps = {
  timestamp: string | number | Date | null | undefined;
  className?: string;
};

/**
 * Used by chat's MessageComponent and ToolGroupContainer to stamp a transcript
 * row with when its provider recorded it (the moment a turn was sent, or a reply
 * block finished) — on every row that carries a timestamp, grouped or not.
 *
 * A row with no usable timestamp renders nothing rather than an empty span, so
 * a caller can place this unconditionally.
 */
const MessageTime = memo(({ timestamp, className }: MessageTimeProps) => {
  const formatted = useMemo(() => formatMessageTimestamp(timestamp), [timestamp]);
  const tooltip = useMemo(() => formatFullTimestampTooltip(timestamp), [timestamp]);

  if (!formatted) {
    return null;
  }

  return (
    <span
      data-testid="message-time"
      title={tooltip}
      className={`select-none whitespace-nowrap text-[10px] text-muted-foreground/70 ${className ?? ''}`}
    >
      {formatted}
    </span>
  );
});
MessageTime.displayName = 'MessageTime';

export default MessageTime;
