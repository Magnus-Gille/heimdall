# Contributing

Issues and focused pull requests are welcome. For security reports, follow `SECURITY.md` instead of opening a public issue.

1. Create a branch from the current default branch.
2. Install dependencies with `npm ci`.
3. Add or update tests for behavioral changes.
4. Run `npm test` and `npm run lint`.
5. Keep deployment-specific addresses, names, credentials, and local status notes out of commits.

Use RFC 5737 addresses (`192.0.2.0/24`, `198.51.100.0/24`, or `203.0.113.0/24`) and `.example` domains in documentation and fixtures. New ingest or mutation endpoints must fail closed, authenticate explicitly, and include negative authorization tests.
