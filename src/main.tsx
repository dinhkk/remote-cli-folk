import { renderBootFailure } from '@/shared/transport/boot-failure';
import { prepareTargetMode } from '@/shared/transport/target-bootstrap';

// Boot is split in two. In a Remote tab the transport bootstrap must finish
// (storage stand-in installed, session received from the Controller page)
// before any application module is evaluated; in Local mode it returns at once.
// The application itself lives in app-entry.tsx. A failure on either step shows
// a plain message instead of leaving a blank page.
void prepareTargetMode()
  .then(() => import('@/app-entry'))
  .catch(renderBootFailure);
