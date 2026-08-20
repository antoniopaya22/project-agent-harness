// Credential detection, used by the commit gate and by `doctor`.
//
// Shape-based rather than a list of providers: the point is to stop a token before it
// exists in history, and a provider that changes its prefix next year should not need a
// code change to be caught. False positives are cheap — `--allow-secret` exists and records
// itself in the commit body. A false negative is permanent.

export const SECRET_PATTERNS = [
  {
    name: 'assignment',
    re: /(?:api[_-]?key|secret|token|password|passwd|credential)\s*[:=]\s*['"`]?[A-Za-z0-9_\-]{16,}/i,
  },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/ },
  { name: 'aws access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'bearer header', re: /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._\-]{20,}/i },
  { name: 'provider token', re: /\b(?:gh[pousr]|xox[baprs]|sk|pk|glpat)[-_][A-Za-z0-9_\-]{20,}\b/ },
  { name: 'connection string with password', re: /\b[a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:[^\s:@/]{8,}@/i },
];

/**
 * @param {string} text lines to scan; when scanning a diff, pass only the added lines
 * @returns {{name:string, line:number, excerpt:string}[]}
 */
export function findSecrets(text) {
  const hits = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(line)) {
          hits.push({ name, line: i + 1, excerpt: line.trim().slice(0, 80) });
          break; // one finding per line is enough to refuse it
        }
      }
    });
  return hits;
}
