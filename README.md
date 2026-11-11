# GUITinstal

Two things live here:

| Folder | What it is |
| --- | --- |
| [`app/`](app) | The desktop application. Reads a GitHub repository, detects the stack, writes an install plan, runs each command **after you approve it**. Pure Node.js, zero dependencies. |
| [`site/`](site) | The public website: landing page + install guide. Static, no build step, ready to deploy on Vercel. |

```bash
node app/server/main.js --open     # run the app
node app/tools/serve-site.js 4173  # preview the website
```

## Product description (English)

**Short — for the GitHub "About" field (max 350 chars):**

> Set up any GitHub project in one click. GUITinstal reads a repository, detects the
> stack, builds an install plan, and runs each command only after you approve it.
> Free, offline desktop app for Windows, macOS and Linux.

**Long — for the repo header, release notes and store listings:**

> GUITinstal is a cross-platform desktop app that turns any GitHub repository into a working
> local project. Paste a URL or a `owner/repo` name and GUITinstal fetches the
> repository, reads the lockfiles and manifests, detects the stack (Node, Python,
> Java, .NET, Go, Rust, PHP and more), and writes a step-by-step install plan: the
> runtime it needs, the packages it will install, the commands it will run, and what
> could go wrong. Nothing executes until you press **Approve** on each step — you see
> the exact command line first. Progress streams into a live console, and every run is
> recorded per project so you can retry a failed step instead of starting over.
>
> It runs entirely on your machine. There is no account, no telemetry and no cloud
> service: GUITinstal talks to GitHub over HTTPS, writes its plan, and shells out to
> the toolchains you already have. The local server binds to `127.0.0.1` only, on a
> random port, and every request needs a per-session token, so nothing else on your
> network can drive it. Commands are launched as argument arrays with `shell: false`,
> which removes the usual "type a project name, get code execution" hole, and it
> checks free disk space before installing anything heavy.
>
> Once a project is prepared, run it directly from its card in the library. Web
> projects open in the browser automatically; GUITinstal also records output so
> startup failures can be diagnosed from the app.
>
> Built with pure Node.js and packaged with Electron for Windows, macOS and Linux.
> Windows ships NSIS and portable x64 installers, macOS a universal DMG, and Linux
> an x86_64 AppImage. Builds are unsigned; macOS may warn before opening the app.

## Universal Engine configuration

`app/core/engine/` holds the engine configuration: the runtime catalog, the
requirements of each stack, the project categories, the compatibility rules,
the sixteen step workflow and the policies the app holds itself to.

The compatibility engine is wired into the plan builder. It receives the
adapters that really exist in this build, and its verdict decides which steps a
plan contains: an **installable** runtime becomes a `prepare-<id>` step, a
**guided** one becomes its official page, and a **blocked** project cannot
start a run at all — the server refuses it and the interface shows the reason
instead of an Install button.

`app/core/runtime-install.js` now has nine Windows adapters, each resolving the
current release from the vendor's own index and verifying the digest that index
publishes before anything runs:

| Adapter | Where the version and digest come from |
| --- | --- |
| Node.js + npm | `nodejs.org/dist/index.json` and `SHASUMS256.txt` |
| Python + pip | `astral-sh/python-build-standalone` release and `SHA256SUMS` |
| Go | `go.dev/dl/?mode=json` |
| Java (Temurin JDK 21) | `api.adoptium.net` |
| uv | `astral-sh/uv` release and `.sha256` |
| Bun | `oven-sh/bun` release and `SHASUMS256.txt` |
| PHP 8 | `windows.php.net/download` |
| Composer | `getcomposer.org` `.sha256sum` |
| rustup + cargo | `static.rust-lang.org` `.sha256` |

Rust needs a linker after `rustc` runs. When the machine has no Visual Studio
C++ build tools, the adapter installs the GNU toolchain, which carries its own
linker, instead of leaving a Rust that can compile and cannot link.

Maven, Gradle, .NET, Ruby, Docker, MSYS2 and Clang have no adapter yet, so they
stay guided installs with their official page attached. Nothing is claimed as
universally compatible.

```bash
cd app
npm run check:engine      # 28 checks over the classifier and the catalog
npm run check:plans       # 21 checks over compatibility -> plan
npm run check:adapters    # adapters vs catalog, offline
node tools/runtime-adapters-check.js --live  # each vendor's current release
node tools/install-proof.js install go   # real install, then compile and run
node tools/install-proof.js persist      # restart test: reuse all, download none
npm run report:engine     # coverage report on screen and in Reports/
```

The details, the catalog format and the API are in
[`app/docs/UNIVERSAL-ENGINE.md`](app/docs/UNIVERSAL-ENGINE.md).

## Releases

```bash
cd app
npm install                 # electron + electron-builder (dev only)
npm run dist:win            # -> NSIS + portable x64
npm run dist:mac            # -> universal DMG (build on macOS)
npm run dist:linux          # -> AppImage x64
```

Pushing a tag `v<version>` runs `.github/workflows/release.yml` on native Windows,
macOS and Linux runners, then publishes the installers as a GitHub Release. The
website reads the latest public release assets and selects a download for the
visitor's operating system.

Social icons in the site header and footer come from the same file:

```bash
node tools/make-site-release.js \
  --base https://github.com/<owner>/guitinstal/releases/download/v1.0.0 \
  --github https://github.com/<owner> \
  --discord https://discord.gg/<code> \
  --x https://x.com/<handle> \
  --youtube https://youtube.com/@<handle>
```

Pass a URL once and it stays in `site/releases.json` on later runs. An icon whose
URL is empty is removed from the page rather than rendered as a dead link.

`make-site-release.js` can write local build metadata to `site/releases.json`.
On the public site, the buttons read the latest public GitHub Release directly,
so publishing the release assets activates the Windows, macOS and Linux downloads.

The installers are **unsigned**: Windows SmartScreen and macOS Gatekeeper may warn
before the first run. The site documents this instead of hiding it
(see `site/download.html`).

## Why the .exe is not inside the site folder

A Vercel Hobby deploy is capped at 100 MB of uploaded source, and the installer is
115 MB. Free bandwidth is 100 GB/month, which is roughly 860 downloads. So the
binaries belong on GitHub Releases (2 GB per file, free) or object storage, and the
Vercel site links out to them.

## Publishing the website

```bash
cd site
vercel link      # first time
vercel --prod
```

## Known state of things

- The desktop packaging targets Windows, macOS and Linux. Runtime adapters are
  currently Windows-only, so macOS/Linux guide users to install missing runtimes
  from their official sources.
- The app interface is in English, the same as the website.
- Nine runtimes can be installed by the app itself on Windows, and each of the
  nine was proven by installing it and using it (a venv, a compiled Go binary, a
  JDK compile, a `uv sync`, a Bun install, a PHP server, a Composer install, a
  Cargo build). The rest of the catalog is a guided install with the official
  page attached.
- A command that asks for confirmation interactively fails instead of hanging
  (the runner closes stdin on purpose).
