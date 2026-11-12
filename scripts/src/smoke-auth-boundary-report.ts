// Security-2E: the "not checked" report for the route smoke suite.
//
// It lives in its own module because smoke-negis-routes.ts starts itself on
// import, so nothing can exercise a function defined inside it without firing
// the whole network run. Here the formatting is a pure function with a test.

/**
 * Builds the lines the smoke run prints for the private routes it only reached
 * the auth boundary of. Returns an empty array when there were none, so a run
 * that never got that far prints nothing rather than an empty heading.
 */
export function formatAuthBoundaryCoverage(paths: Iterable<string>): string[] {
  const unique = [...new Set(paths)].sort();
  if (unique.length === 0) return [];

  return [
    "",
    `NOT CHECKED: ${unique.length} private routes were verified only at the auth boundary (401). ` +
      "Their request and response contracts were not exercised by this run; to cover them, run the " +
      "handler-level suites (test:tenant-isolation, test:api-surface-authorization, test:storage-isolation).",
    ...unique.map((path) => `  - ${path}`),
  ];
}
