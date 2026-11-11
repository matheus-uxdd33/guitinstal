# Release v0.7.13 — 2026-11-11

- Version: 0.7.13
- Notes: Added My GitHub public repository discovery and corrected platform/security guidance. This release has Windows installers; Linux and macOS native packages remain pending.
- Prepared by: npm run release (tools/release.js)
- Products: win32 x64, Node v26.2.0
- Files changed: README.md, app/CHANGELOG.md, app/README.md, app/core/github.js, app/package-lock.json, app/package.json, app/server/api.js, app/tools/release.js, app/ui/app.js, app/ui/index.html, site/download.html, site/index.html, site/releases.json, app/tools/github-repos-selftest.js, app/tools/project-launch-selftest.js

## Assets

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| GUITinstal-0.7.13-Setup-x64.exe | 121853583 | `f5324382c4c04ec65b6be8f6aac39d59d52ee3f6422847a9fadcdd98a4517dbc` |
| GUITinstal-0.7.13-Portable-x64.exe | 110621708 | `732a9028d283d9eaf7d35335a21035087fa8c16c3bd287a1a04a687dc4d26073` |

## Checks executed

| Check | Result | Seconds |
| --- | --- | ---: |
| syntax and catalog | pass | 4 |
| engine selftest | pass | 0 |
| plan selftest | pass | 1 |
| adapter coverage | pass | 0 |
| site/releases.json | pass | 1 |

## Publication state

- Site metadata version: 0.7.13
- GitHub release upload: **pending** (not performed by this command)
- Asset verification (HTTP 200 + digest): **pending**
- Vercel production deploy: **pending**

## Not run

- Adapter install proofs and the end-to-end smoke test were not run (use --full, or run them separately).
