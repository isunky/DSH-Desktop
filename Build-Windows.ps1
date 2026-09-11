#Requires -Version 7.2

[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($PSVersionTable.PSVersion.Major -ge 7) {
    $PSStyle.OutputRendering = 'PlainText'
}

$projectRoot = $PSScriptRoot
$stepNumber = 0

function Write-Step {
    param([Parameter(Mandatory)][string]$Message)
    $script:stepNumber++
    Write-Host ""
    Write-Host "[$script:stepNumber] $Message" -ForegroundColor Cyan
}

function Require-Command {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$InstallHint
    )

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name. $InstallHint"
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(ValueFromRemainingArguments)][string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $Command $($Arguments -join ' ')"
    }
}

try {
    if (-not $IsWindows) {
        throw 'This script can only run on Windows x64.'
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'Only Windows x64 is supported.'
    }

    Set-Location -LiteralPath $projectRoot
    Write-Host 'DeepSeek Harness Desktop - Windows Build' -ForegroundColor Green
    Write-Host "Project: $projectRoot"

    Write-Step 'Checking build environment'
    Require-Command -Name 'git' -InstallHint 'Install Git for Windows: https://git-scm.com/download/win'
    Require-Command -Name 'node' -InstallHint 'Install Node.js 22.19+: https://nodejs.org/'
    Require-Command -Name 'corepack' -InstallHint 'Install Node.js 22.19+ with Corepack.'
    Require-Command -Name 'cargo' -InstallHint 'Install Rust stable and the MSVC toolchain: https://rustup.rs/'
    Require-Command -Name 'rustc' -InstallHint 'Install Rust stable and the MSVC toolchain: https://rustup.rs/'

    $nodeVersionText = (& node -p "process.versions.node").Trim()
    $nodeVersion = [version]$nodeVersionText
    $nodeArch = (& node -p "process.arch").Trim()
    if ($nodeVersion -lt [version]'22.19.0') {
        throw "Node.js $nodeVersionText is too old. Version 22.19.0 or newer is required."
    }
    if ($nodeArch -ne 'x64') {
        throw "The current Node.js architecture is $nodeArch. Windows x64 is required."
    }

    $rustInfo = (& rustc -vV) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $rustInfo -notmatch 'host:\s+x86_64-pc-windows-msvc') {
        throw 'Rust x86_64-pc-windows-msvc is required. Install Visual Studio C++ Build Tools, then run: rustup default stable-x86_64-pc-windows-msvc'
    }
    Write-Host "Node.js $nodeVersionText ($nodeArch)"
    Write-Host ((& rustc --version) -join '')

    Write-Step 'Initializing the official upstream submodule'
    Invoke-Checked git submodule update --init --recursive

    if (-not $SkipInstall) {
        Write-Step 'Installing project dependencies'
        Invoke-Checked corepack pnpm install --frozen-lockfile
    }

    Write-Step 'Checking Tauri CLI'
    & cargo tauri --version *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Installing Tauri CLI 2.11.4 for the first build. This may take several minutes.' -ForegroundColor Yellow
        Invoke-Checked cargo install tauri-cli --version 2.11.4 --locked
    }
    Invoke-Checked cargo tauri --version

    if (-not $SkipChecks) {
        Write-Step 'Running client checks and tests'
        Invoke-Checked corepack pnpm run client:check
        Invoke-Checked node --test client/runtime/hide-console.test.cjs
        Invoke-Checked cargo fmt --manifest-path src-tauri/Cargo.toml --check
        Invoke-Checked cargo test --manifest-path src-tauri/Cargo.toml
    }

    Write-Step 'Building the Windows x64 installer'
    Invoke-Checked corepack pnpm run client:package:win

    $artifactRoot = Join-Path $projectRoot 'artifacts\win-x64'
    Write-Step 'Build completed'
    $artifacts = Get-ChildItem -LiteralPath $artifactRoot -File |
        Where-Object { $_.Extension -eq '.exe' } |
        Sort-Object Name
    foreach ($artifact in $artifacts) {
        $sizeMb = [math]::Round($artifact.Length / 1MB, 1)
        Write-Host "  $($artifact.FullName)  ($sizeMb MB)" -ForegroundColor Green
    }
    Write-Host ""
    Write-Host 'Run the generated installer to install DeepSeek Harness Desktop.' -ForegroundColor Green
    exit 0
}
catch {
    Write-Host ""
    Write-Host "Build failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Review the output above. Common causes are missing Visual Studio C++ Build Tools, Rust, or network access.' -ForegroundColor Yellow
    exit 1
}
finally {
    Set-Location -LiteralPath $projectRoot
}
