/** The IR's and the plugin manifest's grammar-revision form: one pre-release or one build suffix, never both. */
export const GRAMMAR_REVISION_PATTERN: RegExp = /^[\w./@-]+@\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/
