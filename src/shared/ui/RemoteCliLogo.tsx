type RemoteCliLogoProps = {
  className?: string;
};

/**
 * The RemoteCLI mark: a monitor showing a terminal prompt, with signal arcs leaving its corner
 * (a machine you reach from elsewhere). Drawn in `currentColor` with no background, so it sits on
 * whatever tile the caller provides; the same geometry is in public/logo.svg and public/favicon.svg.
 * Rendered by SidebarHeader and the Settings About tab.
 */
const RemoteCliLogo = ({ className = 'h-5 w-5' }: RemoteCliLogoProps) => (
  <svg
    viewBox="2 1.25 29 29"
    aria-hidden="true"
    className={className}
    fill="none"
    stroke="currentColor"
    strokeWidth={2.2}
    strokeLinecap="round"
    strokeLinejoin="round"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="4" y="11" width="18" height="12" rx="2.5" />
    <path d="M13 23v3M9 26.5h8" />
    <path d="M8.5 15.5l3 2.5-3 2.5M13.5 20.5h4" />
    <path d="M22 7a4 4 0 0 1 4 4M22 4a7 7 0 0 1 7 7" />
  </svg>
);

export default RemoteCliLogo;
