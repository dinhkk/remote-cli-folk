// fileTreeRoutes: used by the server entrypoint to mount the complete authenticated File Tree API at `/api/file-tree`.
export { fileTreeRoutes } from '@/modules/file-tree/file-tree.module.js';

// HTML_PREVIEW_CSP: the policy of the HTML preview document. The Remote Controller sets the same value on the page it
// serves for a frame load, so the policy lives in one place.
export { HTML_PREVIEW_CSP } from './html-preview-csp.js';
