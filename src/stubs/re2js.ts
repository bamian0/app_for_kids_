// Stands in for re2js, which Firestore bundles only for client-side pipeline regex functions
// (regexMatch, like). The app never uses pipelines, and the real library is 144 kB of the bundle.
// vite.config.ts aliases 're2js' here; if a pipeline ever needs it, this fails loudly.
function unsupported(): never {
  throw new Error('re2js is stubbed out: Firestore pipeline regex functions are not available in this build')
}

export const RE2JS = { compile: unsupported, matches: unsupported, quote: unsupported }
export default RE2JS
