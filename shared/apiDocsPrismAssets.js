// Prism files that public/api-docs.html loads from its own origin. The client build copies them from the
// installed `prismjs` package (the version in package-lock.json); nothing is fetched from another host.
// The version is part of the served path: assets are cached as immutable, and a different installed version
// fails the build instead of serving files the page was not written for.

export const API_DOCS_PRISM_VERSION = '1.30.0';

export const API_DOCS_PRISM_DIR = `vendor/prism-${API_DOCS_PRISM_VERSION}`;

// Package file -> served file name, in the order the page loads them (clike before javascript).
export const API_DOCS_PRISM_FILES = [
  ['themes/prism-tomorrow.min.css', 'prism-tomorrow.min.css'],
  ['components/prism-core.min.js', 'prism-core.min.js'],
  ['components/prism-clike.min.js', 'prism-clike.min.js'],
  ['components/prism-javascript.min.js', 'prism-javascript.min.js'],
  ['components/prism-bash.min.js', 'prism-bash.min.js'],
  ['components/prism-python.min.js', 'prism-python.min.js'],
  ['components/prism-json.min.js', 'prism-json.min.js'],
  ['components/prism-yaml.min.js', 'prism-yaml.min.js'],
  ['components/prism-http.min.js', 'prism-http.min.js'],
  ['LICENSE', 'LICENSE'],
];
