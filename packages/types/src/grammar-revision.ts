/** The schema's `<grammar-package>@<MAJOR.MINOR.PATCH>` form, one pre-release or build suffix allowed. */
export const GRAMMAR_REVISION_PATTERN: RegExp = /^[\w./@-]+@\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/
