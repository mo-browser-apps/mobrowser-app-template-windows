# MoControl signing CLI

`mocontrol-cli` checks, builds, signs, and packages MoBrowser apps on macOS and Windows.

## Relationship to the MōControl cloud product

This signing CLI is separate from the cloud product's Organizations. Its default provider authenticates against the
local `signing-dev-server` loopback service (device approval + project/platform-bound leases); it does not
use MōControl web sessions, Organization memberships, invitations, or the cloud CLI Config-read service
(`services/cli-config-read`, which serves `GET /v1/orgs/{organizationId}/configs/{configId}/values` to
Organization members). CI can select the environment provider described below; neither provider selects an Organization.

## Before you start

The CLI receives signing credentials through the separately packaged loopback service in
`signing-dev-server/`. The server keeps the credential file private. The CLI stores non-secret session metadata under `~/.mocontrol` and
stores the short-lived session token in macOS Keychain, Windows Credential Manager, or Linux
Secret Service.

For setup instructions, follow the standalone server guide:

- [Windows quick start](../signing-dev-server/README.md#windows-quick-start)
- [macOS quick start](../signing-dev-server/README.md#macos-quick-start)

The CLI knows the default local server address. Run `mocontrol-cli auth login` and approve the
local browser page it opens. `--server` is only needed when testing another address.

The server is development-only. It binds to `127.0.0.1`, hashes tokens in memory, issues 15-minute
sessions and single-use 60-second project/platform leases, and records credential access without
logging secrets. It must be running while `doctor` or `sign` starts. Restarting it invalidates the
saved token; log in again after restarting it.

| Platform | Required env values                                                             |
| -------- | ------------------------------------------------------------------------------- |
| macOS    | All six `MACOS_*` values                                                        |
| Windows  | Azure signing resource values; optional client ID, tenant ID, and client secret |

## Install from this checkout

```sh
cd /path/to/mocontrol/cli
npm install
npm run build
npm link
```

`npm link` makes the `mocontrol-cli` command available in your terminal.

## macOS: check and sign

Requires macOS 14+ on Apple Silicon and a Developer ID Application certificate exported
with its private key as a password-protected `.p12` file. Set `MACOS_SIGNING_P12_PATH`
and `MACOS_SIGNING_P12_PASSWORD`; the CLI imports the P12 into a temporary keychain
during signing, then removes it. You do not need to install the certificate manually.

```zsh
mocontrol-cli doctor \
  --platform macos \
  --project /path/to/app

mocontrol-cli sign \
  --platform macos \
  --project /path/to/app
```

## Windows: check and sign

Requires x64 Windows, 64-bit Node.js and PowerShell, .NET 8 x64, and the Visual C++ x64 runtime.

```powershell
mocontrol-cli doctor `
  --platform windows `
  --project C:\Projects\my-mobrowser-app

mocontrol-cli sign `
  --platform windows `
  --project C:\Projects\my-mobrowser-app
```

With `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_CLIENT_SECRET` in the server `.env`, Windows
signing logs in to Azure automatically. You do not need to run `az login`.

## What the commands do

- `doctor` checks your machine, app configuration, signing values, and Azure/Apple access. It does
  not build or sign anything.
- `sign` builds, signs, verifies, and packages the app. Only run it after `doctor` has no
  `MISSING` lines.

`release` is kept as an alias for `sign`.

## Credential handling

The CLI stores its session token in the operating system credential manager, with no plaintext
fallback. The development server issues short-lived, project/platform-bound signing leases; the CLI
receives usable signing material for that release. This is local signing, not an isolated hosted signer.

macOS releases use a temporary keychain and verify the app signature, identifier, notarization ticket
and Gatekeeper assessment before packaging. Windows releases isolate signing credentials from project
npm scripts and verify signed binaries and installers. Project and platform locks serialize shared
signing resources; interrupted runs clean up temporary resources.

See [CI and real signing checks](docs/CI.md) and the [development server API](../signing-dev-server/API.md).
The execution code is in `src/core/mac` and `src/core/windows`; credential transport is in
`src/remote-signing-context.ts` and local session storage in `src/auth-store.ts`.

## Unattended CI signing

Use `mocontrol-cli sign --project . --platform macos --signing-provider env` to read signing
material directly from the runner environment. This path does not log in to the loopback server.
The default `remote` provider and the `doctor` command retain their existing login flow.

Generated MoControl repositories map their organization signing configuration as follows:

| Repository secret       | CLI input                                                                      |
| ----------------------- | ------------------------------------------------------------------------------ |
| `MAC_CERTIFICATE`       | Decode base64 into a temporary file; pass its path as `MACOS_SIGNING_P12_PATH` |
| `MAC_CERTIFICATE_PWD`   | `MACOS_SIGNING_P12_PASSWORD`                                                   |
| `MAC_CODESIGN_IDENTITY` | `MACOS_CODESIGN_IDENTITY`                                                      |
| `MAC_TEAM_ID`           | `MACOS_TEAM_ID`                                                                |
| `MAC_APPLE_ID`          | `MACOS_APPLE_ID`                                                               |
| `MAC_APPLE_PASSWORD`    | `MACOS_APPLE_PASSWORD`                                                         |

`MAC_PROVISIONING_PROFILE` remains part of the shared configuration; Developer ID distribution
of this starter does not require it. Keep the `MACOS_*` placeholders in `mobrowser.conf.json`.
The workflow removes the decoded P12, and the CLI removes its temporary keychain on success,
failure and interruption. No signing value belongs in source or a command-line argument.
