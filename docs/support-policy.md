# Versions and support

- **Semantic Versioning.** Patch releases (1.0.x) fix bugs and security issues. Minor releases (1.x.0) add
  features without breaking configurations or tool names. Breaking changes only in major releases (2.0.0),
  announced at least one minor release earlier under "Deprecated" in the changelog.
- **Supported versions.** The latest minor release of the current major version receives fixes. Security fixes
  are also back-ported to the previous minor release for 90 days after a new minor release.
- **Node.js.** Supported on Node.js versions that are in "Active LTS" or "Maintenance LTS" and at least
  20.19.0. Dropping a Node.js version is a minor release when that version has reached end-of-life, otherwise
  a major release.
- **Mail providers.** Tested on every release: Gmail (app password), Google Workspace (OAuth), Microsoft 365
  (OAuth), one German/Austrian hoster, and a self-hosted Dovecot/Postfix server.
- **Dependencies.** Updated through Dependabot with a 7-day waiting period (30 days for major versions);
  `npm audit --omit=dev` must report no high or critical issues for a release.
- **Security reports.** See [SECURITY.md](../SECURITY.md); please do not open public issues for vulnerabilities.
