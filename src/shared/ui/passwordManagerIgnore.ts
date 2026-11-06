/**
 * Props that ask password managers not to offer to fill or save a field: the
 * vendor opt-outs of LastPass, 1Password and Bitwarden. For secrets that are not
 * the account login (the relay secret, the setup token). Combine with
 * `autoComplete="new-password"` on masked fields, since browsers ignore
 * `autoComplete="off"` on password inputs, and with a `name` that does not read
 * as a username or password. Best effort only: no attribute can force a browser
 * or a manager to stay away. Used by RelayConfigPanel and AuthInputField (exported from the ui barrel).
 */
export const PASSWORD_MANAGER_IGNORE = {
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
} as const;
