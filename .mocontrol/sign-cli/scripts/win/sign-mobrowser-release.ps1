<#
.SYNOPSIS
Builds, signs, verifies, and packages a MoBrowser Windows release.

.DESCRIPTION
This is the complete Windows release workflow. The Node CLI passes signing
resource metadata as explicit PowerShell arguments; this script never reads a
dotenv file or target-project signing script.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][string]$SigningEndpoint,
    [Parameter(Mandatory)][string]$SigningAccountName,
    [Parameter(Mandatory)][string]$SigningProfileName,
    [Parameter(Mandatory)][string]$ExpectedPackageId,
    [Parameter(Mandatory)][string]$SubscriptionId,
    [string]$Architecture = "win-x64",
    [string]$ToolsDirectory = (Join-Path $HOME "artifact-signing-tools"),
    [string]$MetadataPath,
    [string]$AzureClientId,
    [string]$AzureTenantId,
    [string]$AzureClientCertificatePath
)

$ErrorActionPreference = "Stop"

# Metadata selects the Azure signing account/profile. It must be private to one
# release so concurrent releases cannot overwrite one another's selection.
$ownedMetadataDirectory = $null
$ownedReleaseToolsDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("mobrowser-sign-tools-" + [Guid]::NewGuid().ToString("N"))
$ownedBuildAzureConfigDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("mobrowser-sign-build-azure-" + [Guid]::NewGuid().ToString("N"))
$ownedServicePrincipalAzureConfigDirectory = $null
$originalAzureConfigDirectory = $env:AZURE_CONFIG_DIR
$signingAzureConfigDirectory = $null
$previousSubscriptionId = $null
$servicePrincipalLoginPerformed = $false
# The Node launcher supplies this only for a configured client-secret login.
# Remove it before any project npm script can inherit it.
$azureClientSecret = $env:AZURE_CLIENT_SECRET
Remove-Item Env:AZURE_CLIENT_SECRET -ErrorAction SilentlyContinue
if ([string]::IsNullOrWhiteSpace($MetadataPath)) {
    $ownedMetadataDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("mobrowser-sign-" + [Guid]::NewGuid().ToString("N"))
    $MetadataPath = Join-Path $ownedMetadataDirectory "metadata.json"
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$FailureMessage
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage (exit code $LASTEXITCODE)."
    }
}

function Set-AzureConfigDirectory {
    param([AllowNull()][string]$Directory)

    if ([string]::IsNullOrWhiteSpace($Directory)) {
        Remove-Item Env:AZURE_CONFIG_DIR -ErrorAction SilentlyContinue
    }
    else {
        $env:AZURE_CONFIG_DIR = $Directory
    }
}

function Invoke-AzureCertificateLogin {
    param(
        [Parameter(Mandatory)][string]$ClientId,
        [Parameter(Mandatory)][string]$TenantId,
        [Parameter(Mandatory)][string]$CertificatePath
    )

    Invoke-NativeCommand -FilePath "az" -Arguments @(
        "login", "--service-principal",
        "--username", $ClientId,
        "--certificate", $CertificatePath,
        "--tenant", $TenantId,
        "--output", "none", "--only-show-errors"
    ) -FailureMessage "Azure service-principal login failed"
}

function Invoke-AzureClientSecretLogin {
    param(
        [Parameter(Mandatory)][string]$ClientId,
        [Parameter(Mandatory)][string]$TenantId,
        [Parameter(Mandatory)][string]$ClientSecret
    )

    Invoke-NativeCommand -FilePath "az" -Arguments @(
        "login", "--service-principal",
        "--username", $ClientId,
        "--password=$ClientSecret",
        "--tenant", $TenantId,
        "--output", "none", "--only-show-errors"
    ) -FailureMessage "Azure service-principal login failed"
}

function Invoke-AzureServicePrincipalLogout {
    param([Parameter(Mandatory)][string]$ClientId)

    Invoke-NativeCommand -FilePath "az" -Arguments @(
        "logout", "--username", $ClientId, "--only-show-errors"
    ) -FailureMessage "Azure service-principal logout failed"
}

function Assert-DotNet8X64Runtime {
    if (
        [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64 -or
        [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64
    ) {
        throw "MoBrowser Windows releases require x64 Windows and a 64-bit x64 PowerShell process."
    }

    $runtimeDirectory = Join-Path $env:ProgramFiles "dotnet\shared\Microsoft.NETCore.App"
    $net8Runtime = Get-ChildItem -LiteralPath $runtimeDirectory -Directory -ErrorAction SilentlyContinue |
        Where-Object Name -Match "^8\.\d+\.\d+$" |
        Select-Object -First 1
    if (-not $net8Runtime) {
        throw ".NET 8 x64 Runtime was not found under $runtimeDirectory. Install it, then run this script again."
    }
}

function Assert-VisualCppX64Runtime {
    $runtimeKey = "HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64"
    $runtime = Get-ItemProperty -LiteralPath $runtimeKey -ErrorAction SilentlyContinue
    if ($null -eq $runtime -or $runtime.Installed -ne 1) {
        throw "Azure Artifact Signing requires the Visual C++ 2015-2022 x64 Runtime. Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe."
    }
}

function Get-NuGetPackageVersion {
    param([Parameter(Mandatory)][string]$PackagePath)

    return Get-NuGetPackageMetadataValue -PackagePath $PackagePath -PropertyName "version"
}

function Get-NuGetPackageId {
    param([Parameter(Mandatory)][string]$PackagePath)

    return Get-NuGetPackageMetadataValue -PackagePath $PackagePath -PropertyName "id"
}

function Get-NuGetPackageMetadataValue {
    param(
        [Parameter(Mandatory)][string]$PackagePath,
        [Parameter(Mandatory)][string]$PropertyName
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($PackagePath)
    try {
        $manifestEntry = $archive.Entries | Where-Object Name -like "*.nuspec" | Select-Object -First 1
        if (-not $manifestEntry) { throw "Package manifest was not found: $PackagePath" }
        $reader = [System.IO.StreamReader]::new($manifestEntry.Open())
        try {
            $manifest = [xml]$reader.ReadToEnd()
            $value = [string]$manifest.package.metadata.$PropertyName
            if ([string]::IsNullOrWhiteSpace($value)) {
                throw "NuGet package metadata '$PropertyName' is missing: $PackagePath"
            }
            return $value
        }
        finally {
            $reader.Dispose()
        }
    }
    finally {
        $archive.Dispose()
    }
}

function Assert-ExpectedPackageIdentity {
    param(
        [Parameter(Mandatory)][string]$PackDirectory,
        [Parameter(Mandatory)][string]$ExpectedId
    )

    $releaseManifestPath = Join-Path $PackDirectory "releases.win.json"
    if (-not (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf)) {
        throw "MoBrowser release metadata was not found: $releaseManifestPath"
    }

    try {
        $releaseManifest = Get-Content -LiteralPath $releaseManifestPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "MoBrowser release metadata is invalid: $releaseManifestPath. $($_.Exception.Message)"
    }

    $assets = @($releaseManifest.Assets)
    if ($assets.Count -eq 0) {
        throw "MoBrowser release metadata contains no assets: $releaseManifestPath"
    }

    foreach ($asset in $assets) {
        $actualId = [string]$asset.PackageId
        if (-not [string]::Equals($actualId, $ExpectedId, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "MoBrowser produced a package for an unauthorized project. Expected package ID '$ExpectedId'; actual package ID '$actualId'."
        }

        $fileName = [string]$asset.FileName
        if ([string]::IsNullOrWhiteSpace($fileName) -or [System.IO.Path]::GetFileName($fileName) -cne $fileName) {
            throw "MoBrowser release metadata contains an unsafe package file name: '$fileName'."
        }
        $packagePath = Join-Path $PackDirectory $fileName
        if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
            throw "MoBrowser release package was not found: $packagePath"
        }
        $packageId = Get-NuGetPackageId -PackagePath $packagePath
        if (-not [string]::Equals($packageId, $ExpectedId, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "NuGet package identity does not match the authorized project. Expected '$ExpectedId'; actual '$packageId': $packagePath"
        }
    }
}

function Assert-ExpectedConfiguredPackageIdentity {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$ExpectedId
    )

    $configPath = Join-Path $Root "mobrowser.conf.json"
    try {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "MoBrowser configuration is invalid: $configPath. $($_.Exception.Message)"
    }
    $actualId = [string]$config.app.bundle.Windows.installer.exe.packageId
    if (-not [string]::Equals($actualId, $ExpectedId, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "MoBrowser configuration changed to an unauthorized Windows package ID. Expected '$ExpectedId'; actual '$actualId'."
    }
}

function Initialize-ArtifactSigningTools {
    param(
        [Parameter(Mandatory)][string]$CacheDirectory,
        [Parameter(Mandatory)][string]$ReleaseDirectory,
        [Parameter(Mandatory)][string]$OutputMetadataPath,
        [Parameter(Mandatory)][string]$Endpoint,
        [Parameter(Mandatory)][string]$AccountName,
        [Parameter(Mandatory)][string]$ProfileName
    )

    New-Item -ItemType Directory -Force $CacheDirectory | Out-Null
    New-Item -ItemType Directory -Force $ReleaseDirectory | Out-Null
    $cachedNuGetPath = Join-Path $CacheDirectory "nuget.exe"
    $approvedNuGetVersion = "7.6.0"
    $approvedNuGetUrl = "https://dist.nuget.org/win-x86-commandline/v$approvedNuGetVersion/nuget.exe"
    $approvedNuGetHash = "751EE5E79481626A428C1241DC7F94BCA2739B32588E669715BC5FB54D8FB8A2"
    if (-not (Test-Path -LiteralPath $cachedNuGetPath)) {
        Invoke-WebRequest -UseBasicParsing -Uri $approvedNuGetUrl -OutFile $cachedNuGetPath
    }
    if ((Get-FileHash -LiteralPath $cachedNuGetPath -Algorithm SHA256).Hash -ne $approvedNuGetHash) {
        throw "nuget.exe does not match the approved NuGet $approvedNuGetVersion SHA-256. Remove $cachedNuGetPath and run this script again."
    }
    $nugetPath = Join-Path $ReleaseDirectory "nuget.exe"
    Copy-Item -LiteralPath $cachedNuGetPath -Destination $nugetPath
    if ((Get-FileHash -LiteralPath $nugetPath -Algorithm SHA256).Hash -ne $approvedNuGetHash) {
        throw "nuget.exe changed while it was copied from the download cache."
    }

    $approvedPackages = @(
        [pscustomobject]@{
            Name = "Microsoft.Windows.SDK.BuildTools"
            Version = "10.0.28000.2270"
            PackageHash = "D939FA052F9C80F878B2A28B7071A6F2C9A51029018BB87A835EBDA6E535A002"
            RequiredFile = "signtool.exe"
            RequiredFileHash = "EB2C41BFA718DF21AB773FE0AAE119C79B6E8BA8A9CD475512B7DD42306FE7B7"
        },
        [pscustomobject]@{
            Name = "Microsoft.ArtifactSigning.Client"
            Version = "1.0.128"
            PackageHash = "74BD7D27E6CE1051409C38D9B46BC8DF0400ECD643D51FFBF2AC00869061E40B"
            RequiredFile = "Azure.CodeSigning.Dlib.dll"
            RequiredFileHash = "2D4C1BBC87467B3AC25BBC49DF58CC8B36A0F92B3E21AA98BBBAD08A4D7C98BA"
        }
    )

    foreach ($package in $approvedPackages) {
        $cachedPackageDirectory = Join-Path $CacheDirectory $package.Name
        $packageArchive = Join-Path $cachedPackageDirectory "$($package.Name).nupkg"
        if (-not (Test-Path -LiteralPath $cachedPackageDirectory)) {
            Invoke-NativeCommand -FilePath $nugetPath -Arguments @("install", $package.Name, "-Version", $package.Version, "-ExcludeVersion", "-OutputDirectory", $CacheDirectory, "-Source", "https://api.nuget.org/v3/index.json") -FailureMessage "Installing $($package.Name) $($package.Version) failed"
        }
        if (-not (Test-Path -LiteralPath $packageArchive)) {
            throw "The package archive is missing: $packageArchive. Remove the incomplete cache directory and run this script again."
        }
        if ((Get-FileHash -LiteralPath $packageArchive -Algorithm SHA256).Hash -ne $package.PackageHash) {
            throw "$($package.Name) $($package.Version) does not match the approved package SHA-256. Remove $cachedPackageDirectory and run this script again."
        }
        Invoke-NativeCommand -FilePath $nugetPath -Arguments @("verify", "-Signatures", $packageArchive) -FailureMessage "Signature verification failed for $packageArchive"
        if ((Get-NuGetPackageVersion $packageArchive) -ne $package.Version) {
            throw "$($package.Name) is not the approved version $($package.Version). Remove $cachedPackageDirectory and run this script again."
        }

        # Never execute assemblies or extract directly from the persistent
        # cache. Copy the approved archive into this release's private working
        # directory and verify the copy before consuming it.
        $releasePackageArchive = Join-Path $ReleaseDirectory "$($package.Name).$($package.Version).nupkg"
        Copy-Item -LiteralPath $packageArchive -Destination $releasePackageArchive
        if ((Get-FileHash -LiteralPath $releasePackageArchive -Algorithm SHA256).Hash -ne $package.PackageHash) {
            throw "$($package.Name) $($package.Version) changed while it was copied from the download cache."
        }
        $releasePackageDirectory = Join-Path $ReleaseDirectory $package.Name
        New-Item -ItemType Directory -Force $releasePackageDirectory | Out-Null
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($releasePackageArchive, $releasePackageDirectory)
        if ((Get-FileHash -LiteralPath $releasePackageArchive -Algorithm SHA256).Hash -ne $package.PackageHash) {
            throw "$($package.Name) $($package.Version) changed while its verified release copy was being extracted."
        }

        $requiredFile = Get-ChildItem -LiteralPath $releasePackageDirectory -Recurse -Filter $package.RequiredFile -File |
            Where-Object FullName -Match "\\x64\\" |
            Select-Object -First 1 -ExpandProperty FullName
        if (-not $requiredFile) {
            throw "The required x64 file was not found in ${releasePackageDirectory}: $($package.RequiredFile)"
        }
        if ((Get-FileHash -LiteralPath $requiredFile -Algorithm SHA256).Hash -ne $package.RequiredFileHash) {
            throw "The required x64 file does not match the approved SHA-256: $requiredFile"
        }
        Write-Host "$($package.Name) $($package.Version) is approved and ready."
    }

    $metadataDirectory = Split-Path -Parent $OutputMetadataPath
    New-Item -ItemType Directory -Force $metadataDirectory | Out-Null
    $metadata = [ordered]@{
        Endpoint = $Endpoint
        CodeSigningAccountName = $AccountName
        CertificateProfileName = $ProfileName
        ExcludeCredentials = @(
            "EnvironmentCredential",
            "WorkloadIdentityCredential",
            "ManagedIdentityCredential",
            "SharedTokenCacheCredential",
            "VisualStudioCredential",
            "VisualStudioCodeCredential",
            "AzurePowerShellCredential",
            "AzureDeveloperCliCredential",
            "InteractiveBrowserCredential"
        )
    } | ConvertTo-Json -Depth 3

    # Azure.CodeSigning.Dlib rejects a UTF-8 byte-order mark.
    [System.IO.File]::WriteAllText($OutputMetadataPath, $metadata, [System.Text.UTF8Encoding]::new($false))
}

function Get-SafeArchitectureOutputDirectory {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$TargetArchitecture
    )

    if ($TargetArchitecture -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        throw "Architecture contains unsafe path characters: $TargetArchitecture"
    }

    $resolvedRoot = (Resolve-Path -LiteralPath $Root -ErrorAction Stop).Path
    $distParent = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot "build\dist"))
    $outputDirectory = [System.IO.Path]::GetFullPath((Join-Path $distParent $TargetArchitecture))
    $distPrefix = $distParent.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $outputDirectory.StartsWith($distPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean output directory outside build/dist: $outputDirectory"
    }

    return $outputDirectory
}

function Clear-SafeArchitectureOutputDirectory {
    param([Parameter(Mandatory)][string]$OutputDirectory)

    if (-not (Test-Path -LiteralPath $OutputDirectory)) { return }

    $outputItem = Get-Item -LiteralPath $OutputDirectory -Force
    if (-not $outputItem.PSIsContainer -or ($outputItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing to recursively delete a non-directory or reparse point: $OutputDirectory"
    }
    $reparsePoint = Get-ChildItem -LiteralPath $OutputDirectory -Force -Recurse -ErrorAction Stop |
        Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint } |
        Select-Object -First 1
    if ($reparsePoint) {
        throw "Refusing to recursively delete output containing a reparse point: $($reparsePoint.FullName)"
    }

    Remove-Item -LiteralPath $OutputDirectory -Recurse -Force
}

function Invoke-ArtifactSigningBatches {
    param(
        [Parameter(Mandatory)][string]$SignTool,
        [Parameter(Mandatory)][string[]]$SigningArguments,
        [Parameter(Mandatory)][System.IO.FileInfo[]]$Files,
        [Parameter(Mandatory)][string]$ArtifactLabel,
        [int]$MaximumBatchFiles = 50,
        [int]$MaximumBatchCharacters = 24000
    )

    if ($MaximumBatchFiles -lt 1 -or $MaximumBatchCharacters -lt 1) {
        throw "Artifact signing batch limits must be positive."
    }

    $baseCharacterCount = $SignTool.Length + ($SigningArguments | ForEach-Object { $_.Length + 3 } | Measure-Object -Sum).Sum
    $batch = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
    $batchState = [pscustomobject]@{ CharacterCount = [int]$baseCharacterCount }

    $invokeBatch = {
        if ($batch.Count -eq 0) { return }
        $batchFiles = $batch.ToArray()
        Invoke-NativeCommand -FilePath $SignTool -Arguments ($SigningArguments + $batchFiles.FullName) -FailureMessage "Signing $ArtifactLabel failed"
        Invoke-NativeCommand -FilePath $SignTool -Arguments (@("verify", "/pa", "/all", "/v") + $batchFiles.FullName) -FailureMessage "Verifying $ArtifactLabel signatures failed"
        $batch.Clear()
        $batchState.CharacterCount = [int]$baseCharacterCount
    }

    foreach ($file in $Files) {
        $fileCharacterCount = $file.FullName.Length + 3
        if ($fileCharacterCount + $baseCharacterCount -gt $MaximumBatchCharacters) {
            throw "Artifact path is too long to sign safely in one command: $($file.FullName)"
        }
        if ($batch.Count -gt 0 -and ($batch.Count -ge $MaximumBatchFiles -or $batchState.CharacterCount + $fileCharacterCount -gt $MaximumBatchCharacters)) {
            & $invokeBatch
        }
        $batch.Add($file)
        $batchState.CharacterCount += $fileCharacterCount
    }
    & $invokeBatch
}

try {
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw "Azure CLI was not found. Install it with: winget install --exact --id Microsoft.AzureCLI"
    }

    Assert-DotNet8X64Runtime
    Assert-VisualCppX64Runtime

    $ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "package.json"))) {
        throw "ProjectRoot must be a MoBrowser application directory containing package.json: $ProjectRoot"
    }
    $distRoot = Get-SafeArchitectureOutputDirectory -Root $ProjectRoot -TargetArchitecture $Architecture
    $binDirectory = Join-Path $distRoot "bin"
    $packDirectory = Join-Path $distRoot "pack"

    # Project-controlled npm lifecycle scripts run without access to the Azure
    # CLI profile used for signing. No signing login has occurred at this point.
    New-Item -ItemType Directory -Force $ownedBuildAzureConfigDirectory | Out-Null
    Set-AzureConfigDirectory $ownedBuildAzureConfigDirectory
    Push-Location -LiteralPath $ProjectRoot
    try {
        Invoke-NativeCommand -FilePath "npm" -Arguments @("ci") -FailureMessage "npm ci failed"
        Clear-SafeArchitectureOutputDirectory -OutputDirectory $distRoot
        Invoke-NativeCommand -FilePath "npm" -Arguments @("run", "build", "--", "--verbose") -FailureMessage "The MoBrowser build failed"
        Assert-ExpectedConfiguredPackageIdentity -Root $ProjectRoot -ExpectedId $ExpectedPackageId
    }
    finally {
        Pop-Location
    }

    Initialize-ArtifactSigningTools -CacheDirectory $ToolsDirectory -ReleaseDirectory $ownedReleaseToolsDirectory -OutputMetadataPath $MetadataPath -Endpoint $SigningEndpoint -AccountName $SigningAccountName -ProfileName $SigningProfileName

    $signTool = Get-ChildItem -LiteralPath (Join-Path $ownedReleaseToolsDirectory "Microsoft.Windows.SDK.BuildTools") -Recurse -Filter "signtool.exe" |
        Where-Object FullName -Match "\\x64\\" |
        Select-Object -First 1 -ExpandProperty FullName
    $dlib = Get-ChildItem -LiteralPath (Join-Path $ownedReleaseToolsDirectory "Microsoft.ArtifactSigning.Client") -Recurse -Filter "Azure.CodeSigning.Dlib.dll" |
        Where-Object FullName -Match "\\x64\\" |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $signTool) { throw "x64 SignTool.exe was not found in the verified release tool directory." }
    if (-not $dlib) { throw "x64 Azure.CodeSigning.Dlib.dll was not found in the verified release tool directory." }
    if ((Get-FileHash -LiteralPath $signTool -Algorithm SHA256).Hash -ne "EB2C41BFA718DF21AB773FE0AAE119C79B6E8BA8A9CD475512B7DD42306FE7B7") {
        throw "x64 SignTool.exe does not match the approved SHA-256."
    }
    if ((Get-FileHash -LiteralPath $dlib -Algorithm SHA256).Hash -ne "2D4C1BBC87467B3AC25BBC49DF58CC8B36A0F92B3E21AA98BBBAD08A4D7C98BA") {
        throw "x64 Azure.CodeSigning.Dlib.dll does not match the approved SHA-256."
    }
    $timestampArguments = @("/tr", "http://timestamp.acs.microsoft.com", "/td", "SHA256", "/dlib", $dlib, "/dmdf", $MetadataPath)

    if (-not [string]::IsNullOrWhiteSpace($AzureClientCertificatePath)) {
        if ([string]::IsNullOrWhiteSpace($AzureClientId) -or [string]::IsNullOrWhiteSpace($AzureTenantId)) {
            throw "Certificate-based Azure login requires an application ID, tenant ID, and certificate path."
        }
        if (-not (Test-Path -LiteralPath $AzureClientCertificatePath -PathType Leaf)) {
            throw "Azure service-principal certificate was not found: $AzureClientCertificatePath"
        }
        $ownedServicePrincipalAzureConfigDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("mobrowser-sign-azure-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force $ownedServicePrincipalAzureConfigDirectory | Out-Null
        $signingAzureConfigDirectory = $ownedServicePrincipalAzureConfigDirectory
        Set-AzureConfigDirectory $signingAzureConfigDirectory
        Invoke-AzureCertificateLogin -ClientId $AzureClientId -TenantId $AzureTenantId -CertificatePath $AzureClientCertificatePath
        $servicePrincipalLoginPerformed = $true
    }
    elseif (-not [string]::IsNullOrWhiteSpace($azureClientSecret)) {
        if ([string]::IsNullOrWhiteSpace($AzureClientId) -or [string]::IsNullOrWhiteSpace($AzureTenantId)) {
            throw "Client-secret Azure login requires an application ID, tenant ID, and client secret."
        }
        $ownedServicePrincipalAzureConfigDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("mobrowser-sign-azure-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force $ownedServicePrincipalAzureConfigDirectory | Out-Null
        $signingAzureConfigDirectory = $ownedServicePrincipalAzureConfigDirectory
        Set-AzureConfigDirectory $signingAzureConfigDirectory
        Invoke-AzureClientSecretLogin -ClientId $AzureClientId -TenantId $AzureTenantId -ClientSecret $azureClientSecret
        $servicePrincipalLoginPerformed = $true
    }
    else {
        $signingAzureConfigDirectory = $originalAzureConfigDirectory
        Set-AzureConfigDirectory $signingAzureConfigDirectory
        # `az account set` changes the selected user profile. Remember it so the
        # release does not leave an interactive user on another subscription.
        $previousSubscriptionId = (& az account show --query "id" --output "tsv" 2>$null)
        if ($LASTEXITCODE -ne 0) {
            $previousSubscriptionId = $null
        }
    }
    Invoke-NativeCommand -FilePath "az" -Arguments @("account", "show", "--output", "none") -FailureMessage "Azure CLI is not authenticated"
    Invoke-NativeCommand -FilePath "az" -Arguments @("account", "set", "--subscription", $SubscriptionId) -FailureMessage "Selecting the Azure subscription failed"

    Push-Location -LiteralPath $ProjectRoot
    try {
        $appFiles = Get-ChildItem -LiteralPath $binDirectory -Recurse -File | Where-Object Extension -In ".exe", ".dll", ".node"
        if (-not $appFiles) { throw "No .exe, .dll, or .node files were found in $binDirectory." }
        Invoke-ArtifactSigningBatches -SignTool $signTool -SigningArguments (@("sign", "/v", "/fd", "SHA256") + $timestampArguments) -Files $appFiles -ArtifactLabel "application files"

        if ($servicePrincipalLoginPerformed) {
            Invoke-AzureServicePrincipalLogout -ClientId $AzureClientId
            $servicePrincipalLoginPerformed = $false
            Remove-Item -LiteralPath $ownedServicePrincipalAzureConfigDirectory -Recurse -Force
            $ownedServicePrincipalAzureConfigDirectory = $null
            $signingAzureConfigDirectory = $null
        }
        Set-AzureConfigDirectory $ownedBuildAzureConfigDirectory
        Invoke-NativeCommand -FilePath "npm" -Arguments @("run", "pack", "--", "--verbose") -FailureMessage "The MoBrowser packaging step failed"
        if (-not [string]::IsNullOrWhiteSpace($AzureClientCertificatePath) -or -not [string]::IsNullOrWhiteSpace($azureClientSecret)) {
            $ownedServicePrincipalAzureConfigDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("mobrowser-sign-azure-" + [Guid]::NewGuid().ToString("N"))
            New-Item -ItemType Directory -Force $ownedServicePrincipalAzureConfigDirectory | Out-Null
            $signingAzureConfigDirectory = $ownedServicePrincipalAzureConfigDirectory
            Set-AzureConfigDirectory $signingAzureConfigDirectory
            if (-not [string]::IsNullOrWhiteSpace($AzureClientCertificatePath)) {
                Invoke-AzureCertificateLogin -ClientId $AzureClientId -TenantId $AzureTenantId -CertificatePath $AzureClientCertificatePath
            }
            else {
                Invoke-AzureClientSecretLogin -ClientId $AzureClientId -TenantId $AzureTenantId -ClientSecret $azureClientSecret
            }
            $servicePrincipalLoginPerformed = $true
            Invoke-NativeCommand -FilePath "az" -Arguments @("account", "set", "--subscription", $SubscriptionId) -FailureMessage "Selecting the Azure subscription failed"
        }
        else {
            Set-AzureConfigDirectory $signingAzureConfigDirectory
        }
        Assert-ExpectedPackageIdentity -PackDirectory $packDirectory -ExpectedId $ExpectedPackageId

        $installers = Get-ChildItem -LiteralPath $packDirectory -Filter "*.exe" -File
        if (-not $installers) { throw "No installer .exe files were found in $packDirectory." }
        Invoke-ArtifactSigningBatches -SignTool $signTool -SigningArguments (@("sign", "/v", "/fd", "SHA256") + $timestampArguments) -Files $installers -ArtifactLabel "installer files"

        $installers.FullName
    }
    finally {
        Set-AzureConfigDirectory $signingAzureConfigDirectory
        Pop-Location
    }
}
finally {
    if ($servicePrincipalLoginPerformed) {
        Set-AzureConfigDirectory $signingAzureConfigDirectory
        & az logout --username $AzureClientId --only-show-errors 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not remove the service-principal Azure CLI login. Run 'az logout --username $AzureClientId' when it is safe to do so."
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($previousSubscriptionId)) {
        Set-AzureConfigDirectory $signingAzureConfigDirectory
        & az account set --subscription $previousSubscriptionId --only-show-errors 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not restore the previous Azure subscription ($previousSubscriptionId). Run 'az account set --subscription $previousSubscriptionId' when it is safe to do so."
        }
    }
    Set-AzureConfigDirectory $originalAzureConfigDirectory
    if ($null -ne $ownedMetadataDirectory) {
        Remove-Item -LiteralPath $ownedMetadataDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $ownedReleaseToolsDirectory -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ownedBuildAzureConfigDirectory -Recurse -Force -ErrorAction SilentlyContinue
    if ($null -ne $ownedServicePrincipalAzureConfigDirectory) {
        Remove-Item -LiteralPath $ownedServicePrincipalAzureConfigDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
