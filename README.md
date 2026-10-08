# Hello World for Windows

A minimal MoBrowser application. Run `npm ci` and `npm run dev` on a supported operating system.

MōControl creates a private repository from this template, configures its application identity, and applies a separate signing profile for each selected OS. Skipping signing creates code without publishing an installer.

The release workflow publishes one target per attempt: macOS ARM64 DMG or Windows x64 EXE. Select the platform and version in MōControl; targets share a version but have independent progress, downloads and retries. Successful artifacts are immutable. Repositories created earlier are not automatically updated.

macOS uses `MAC_CERTIFICATE`, `MAC_CERTIFICATE_PWD`, `MAC_CODESIGN_IDENTITY`, `MAC_TEAM_ID`, `MAC_APPLE_ID`, and `MAC_APPLE_PASSWORD`. The legacy `MAC_KEYCHAIN_PWD` is preserved for compatibility.

Windows uses Azure Artifact Signing with service-principal authentication: `WINDOWS_AZURE_SIGNING_ENDPOINT`, `WINDOWS_AZURE_SIGNING_ACCOUNT_NAME`, `WINDOWS_AZURE_SIGNING_PROFILE_NAME`, `WINDOWS_AZURE_SUBSCRIPTION_ID`, `WINDOWS_AZURE_CLIENT_ID`, `WINDOWS_AZURE_TENANT_ID`, and `WINDOWS_AZURE_CLIENT_SECRET`. The workflow maps these to the signing CLI's `AZURE_*` environment variables. Values belong in encrypted GitHub secrets, never in source files.

The bundled `.mocontrol/sign-cli` performs native signing and verification before `.mocontrol/release.mjs` uploads the installer to the authenticated release service. MōControl supplies `MOCONTROL_RELEASE_TOKEN` and the release-service variables.
