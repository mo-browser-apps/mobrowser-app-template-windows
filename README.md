# MōBrowser App Template — Windows

A minimal MōBrowser application for Windows x64 (EXE).

## Local development

Use Node.js 24 and run `npm ci`, then `npm run dev` on a supported operating system.
`npm run build` builds the application; `npm run pack` packages it on the native platform.
Application source, assets and build configuration live in this template.

## Releases with MoControl

This template contains **no GitHub Actions workflows or managed runtime**. After creating a repository,
[MoControl](https://github.com/mo-browser-apps/control) installs a versioned automation bundle:

- Required **MoControl Release** at `.github/workflows/release.yml`.
- The release helper and signing CLI under `.mocontrol/`.
- Optional CI checks, CI/CD previews, organization workflows, and custom YAML selected during creation.

The initial `0.0.1` release includes every supported platform. Choose MoControl downloads or GitHub
Releases, and a signing profile or **Don’t sign** for each platform. Unsigned installers are still built
and published, but operating systems may warn or require explicit permission to open them.
Credentials belong in encrypted repository secrets, never in workflow inputs or source files.

Platforms build and publish independently. Retrying a failed platform rebuilds its installer using the
original source and settings; successful installers remain unchanged. Downloads use direct installer
links. Private GitHub downloads require repository access. CI/CD previews use the same settings and do
not replace the current stable release.

**Adoption order:** deploy MoControl provisioning support for the canonical automation bundle before
adopting this workflow-free template revision. Creating a repository directly from GitHub does not
install automation. Existing application repositories are not updated automatically.
