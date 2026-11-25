import type { ReactNode } from 'react';

type ProfileFieldProps = {
  label: string;
  /** Id of the control inside, so the label is attached to it. */
  htmlFor?: string;
  children: ReactNode;
  /** Problem shown in red under the control (blocks saving where the form says so). */
  error?: string | null;
  /** Neutral help or warning text under the control. */
  hint?: ReactNode;
};

/** Used by the template editor and the Generate form of the agent-profiles module to lay out a labelled control with its error and hint. */
export function ProfileField({ label, htmlFor, children, error, hint }: ProfileFieldProps) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">{label}</label>
      {children}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
