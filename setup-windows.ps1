<#
.SYNOPSIS
    Register the Chrome Bridge native-messaging host on Windows for the current user.

.DESCRIPTION
    User-scope installer. Everything it writes lives under the repository and
    under HKCU; it never writes HKLM, never requires an elevated shell, and never
    installs a machine-wide or all-users registration.

    It writes a launcher (.cmd) that starts either python.exe bridge.py or the
    Rust host executable, generates the native-messaging manifest, and points the
    HKCU NativeMessagingHosts key at that manifest.

    Existing secrets are never overwritten: bridge_token.txt, bridge_tokens.txt,
    and bridge_policy.json are created only when absent. Token values are never
    printed; stdout is metadata only.

.PARAMETER RepoRoot
    Repository root. Defaults to the directory containing this script.

.PARAMETER HostPort
    Local TCP port the host listens on for CLI/MCP clients. Default 9223.

.PARAMETER ExtensionId
    Extension ID to authorize. Defaults to the contents of extension_id.txt, or
    is derived from extension_key.pem when that key already exists.

.PARAMETER UseRustHost
    Point the manifest at host-rs\target\release\bridge-host.exe instead of Python.

.PARAMETER Browser
    Which HKCU native-messaging root to register: Chrome, Edge, or Both.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File setup-windows.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File setup-windows.ps1 -UseRustHost -Browser Both
#>

[CmdletBinding()]
param(
    [string] $RepoRoot = $PSScriptRoot,
    [int] $HostPort = 9223,
    [string] $ExtensionId = "",
    [switch] $UseRustHost,
    [ValidateSet("Chrome", "Edge", "Both")]
    [string] $Browser = "Chrome"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$HostName = "com.automation.bridge"

# User-scope registry roots only. HKLM is never written by this installer:
# a machine-wide registration would let any account on the box drive the profile.
$ChromeRegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$EdgeRegistryPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"

function Resolve-RepoRoot {
    param([string] $Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "RepoRoot is required."
    }
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    foreach ($required in @("bridge.py", "manifest.json", "bridge_policy.example.json")) {
        if (-not (Test-Path -LiteralPath (Join-Path $resolved $required))) {
            throw "RepoRoot $resolved does not look like a Chrome Bridge checkout (missing $required)."
        }
    }
    return $resolved
}

function Get-PythonExe {
    foreach ($candidate in @("python.exe", "python3.exe", "py.exe")) {
        $found = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($found) { return $found.Source }
    }
    throw "No python.exe found on PATH. Install Python 3.9+ and re-run."
}

function Protect-UserOnly {
    # Break inheritance and grant full control to the current user only.
    param([string] $Path)
    $account = "$env:USERDOMAIN\$env:USERNAME"
    & icacls.exe $Path /inheritance:r /grant:r "${account}:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Could not restrict permissions on $Path; review its ACL manually."
    }
}

function New-SecretFileIfMissing {
    param([string] $Path, [scriptblock] $Producer, [string] $Label)
    if (Test-Path -LiteralPath $Path) {
        Write-Output "Existing $Label kept at $Path"
    }
    else {
        & $Producer
        Write-Output "Created $Label at $Path"
    }
    Protect-UserOnly -Path $Path
}

$RepoRoot = Resolve-RepoRoot -Path $RepoRoot
$python = Get-PythonExe

$tokenFile = Join-Path $RepoRoot "bridge_token.txt"
$tokensFile = Join-Path $RepoRoot "bridge_tokens.txt"
$policyFile = Join-Path $RepoRoot "bridge_policy.json"
$policyExample = Join-Path $RepoRoot "bridge_policy.example.json"
$manifestPath = Join-Path $RepoRoot "$HostName.json"
$launcherPath = Join-Path $RepoRoot "bridge-host-launch.cmd"
$extensionIdFile = Join-Path $RepoRoot "extension_id.txt"
$keyFile = Join-Path $RepoRoot "extension_key.pem"

New-SecretFileIfMissing -Path $tokenFile -Label "bridge token" -Producer {
    $token = & $python -c "import secrets; print(secrets.token_hex(32))"
    Set-Content -LiteralPath $tokenFile -Value $token -Encoding ascii
}
New-SecretFileIfMissing -Path $tokensFile -Label "bridge tokens registry" -Producer {
    Set-Content -LiteralPath $tokensFile -Value "" -Encoding ascii
}
New-SecretFileIfMissing -Path $policyFile -Label "bridge policy" -Producer {
    Copy-Item -LiteralPath $policyExample -Destination $policyFile
}

if ([string]::IsNullOrWhiteSpace($ExtensionId)) {
    if (Test-Path -LiteralPath $extensionIdFile) {
        $ExtensionId = (Get-Content -LiteralPath $extensionIdFile -Raw).Trim()
    }
    elseif (Test-Path -LiteralPath $keyFile) {
        $ExtensionId = (& $python (Join-Path $RepoRoot "extension_identity.py") "id" "--key" $keyFile).Trim()
    }
}
if ($ExtensionId -notmatch '^[a-p]{32}$') {
    throw "Need a valid extension ID (32 chars, a-p). Load the unpacked extension from chrome://extensions/, then re-run with -ExtensionId <id>."
}
Set-Content -LiteralPath $extensionIdFile -Value $ExtensionId -Encoding ascii

if ($UseRustHost) {
    $hostExe = Join-Path $RepoRoot "host-rs\target\release\bridge-host.exe"
    if (-not (Test-Path -LiteralPath $hostExe)) {
        throw "Build the Rust host first: cargo build --release --manifest-path host-rs/Cargo.toml"
    }
    $hostCommand = "`"$hostExe`" %*"
    $hostKind = "rust"
}
else {
    $bridgePy = Join-Path $RepoRoot "bridge.py"
    $hostCommand = "`"$python`" `"$bridgePy`" %*"
    $hostKind = "python"
}

# Native messaging on Windows launches the manifest "path" directly, so a .cmd
# wrapper carries the interpreter and the environment the host expects.
$launcher = @"
@echo off
if "%BRIDGE_PORT%"=="" set BRIDGE_PORT=$HostPort
set BRIDGE_TOKEN_FILE=$tokenFile
set BRIDGE_TOKENS_FILE=$tokensFile
set BRIDGE_POLICY_FILE=$policyFile
set BRIDGE_LOG_FILE=$RepoRoot\bridge_debug.log
set BRIDGE_AUDIT_LOG_FILE=$RepoRoot\bridge_audit.jsonl
$hostCommand
"@
Set-Content -LiteralPath $launcherPath -Value $launcher -Encoding ascii
Write-Output "Wrote launcher $launcherPath"

$manifest = [ordered]@{
    name            = $HostName
    description     = "Chrome Native Messaging Automation Bridge"
    path            = $launcherPath
    type            = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Output "Wrote host manifest $manifestPath"

$registryPaths = @()
if ($Browser -eq "Chrome" -or $Browser -eq "Both") { $registryPaths += $ChromeRegistryPath }
if ($Browser -eq "Edge" -or $Browser -eq "Both") { $registryPaths += $EdgeRegistryPath }

foreach ($registryPath in $registryPaths) {
    if (-not (Test-Path -LiteralPath $registryPath)) {
        New-Item -Path $registryPath -Force | Out-Null
    }
    # Chrome/Edge read the manifest path from the key's UNNAMED (default) value.
    # Set-ItemProperty cannot write that value: the label PowerShell displays for
    # the unnamed value is not a usable property name, so naming it there creates
    # a separate, literally-named value and the browser finds no manifest at all.
    # Set-Item on the key itself writes the real unnamed value.
    Set-Item -LiteralPath $registryPath -Value $manifestPath
    $written = (Get-ItemProperty -LiteralPath $registryPath).'(default)'
    if ($written -ne $manifestPath) {
        throw "Registry default value at $registryPath is '$written', expected '$manifestPath'"
    }
    Write-Output "Registered native host at $registryPath (default value)"
}

Write-Output ""
Write-Output "host name:    $HostName"
Write-Output "host kind:    $hostKind"
Write-Output "host port:    $HostPort"
Write-Output "extension id: $ExtensionId"
Write-Output ""
Write-Output "Next steps:"
Write-Output "  1. Open chrome://extensions/ (or edge://extensions/) and enable Developer mode."
Write-Output "  2. Load unpacked: $(Join-Path $RepoRoot 'extension')"
Write-Output "  3. Confirm the loaded ID is $ExtensionId; a different ID needs a re-run with -ExtensionId."
Write-Output "  4. Enable only one bridge extension at a time; duplicates race for port $HostPort."
Write-Output "  5. Verify: `"$python`" `"$(Join-Path $RepoRoot 'test_client.py')`" ping"
