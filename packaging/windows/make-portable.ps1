# Builds Leverframe_<version>_x64-portable.zip from an already built release executable.
# Usage (repository root): pwsh packaging/windows/make-portable.ps1 [-Exe path] [-OutDir dir]
param(
    [string]$Exe = "src-tauri/target/release/leverframe.exe",
    [string]$OutDir = "dist-portable"
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path $Exe)) { throw "Nie znaleziono $Exe – najpierw zbuduj aplikację (npm run tauri build)." }
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$name = "Leverframe_${version}_x64-portable"
$stage = Join-Path $OutDir $name
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Copy-Item $Exe (Join-Path $stage "Leverframe.exe")
Copy-Item "packaging/windows/CZYTAJ-MNIE.txt" $stage
Copy-Item "CHANGELOG.md" $stage

$zip = Join-Path $OutDir "$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
# Files at the top level of the archive's folder: unpack → folder with Leverframe.exe inside.
Compress-Archive -Path $stage -DestinationPath $zip
Write-Output "Utworzono $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)"
"zip=$zip" | Out-File -FilePath ($env:GITHUB_OUTPUT ?? "NUL") -Append -Encoding utf8
