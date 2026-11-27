$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This setup requires Windows x64.' }

New-Item -ItemType Directory -Force -Path vendor,downloads,data | Out-Null
if (-not (Test-Path -LiteralPath 'vendor\siteone\siteone-crawler\siteone-crawler.exe')) {
    $archive = 'downloads\siteone-v2.5.1-win-x64.zip'
    curl.exe -fsSL --retry 2 --connect-timeout 15 --max-time 420 -H 'Accept: application/octet-stream' -o $archive 'https://api.github.com/repos/janreges/siteone-crawler/releases/assets/459279685?download=1'
    if ($LASTEXITCODE -ne 0) { throw 'SiteOne download failed.' }
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if ($hash -ne '6b6758daa866df99d9bd7a020b51eaeca2d5f52f3172ec5270f9f96b964c16db') {
        throw 'SiteOne download checksum did not match the published release.'
    }
    Expand-Archive -LiteralPath $archive -DestinationPath vendor\siteone
}

$geo = 'vendor\niubigeo'
if (-not (Test-Path -LiteralPath "$geo\package-lock.json")) {
    if (Test-Path -LiteralPath $geo) { throw 'NiubiGEO folder exists without package-lock.json. Move the incomplete folder before retrying.' }
    $commit = '6f0eeeb11b4319e845b491a5067d2cfdc8d07b52'
    $treeUrl = "https://api.github.com/repos/Albert-Weasker/niubigeo/git/trees/${commit}?recursive=1"
    $tree = curl.exe -fsSL --retry 2 --connect-timeout 15 --max-time 90 $treeUrl | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $tree.truncated -or $tree.sha -ne $commit) {
        throw 'Could not read the pinned NiubiGEO source tree.'
    }
    $staging = Join-Path $PSScriptRoot ('downloads\niubigeo-' + [guid]::NewGuid())
    $paths = @($tree.tree | Where-Object {
        $_.type -eq 'blob' -and $_.path -match '^(src/|test/|scripts/|assets/.*\.(svg|woff2|ico)$|package(-lock)?\.json$|tsconfig\.json$|LICENSE$|README(\.zh-CN)?\.md$)'
    })
    $paths | ForEach-Object {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent (Join-Path $staging $_.path)) | Out-Null
    }
    $paths | ForEach-Object -Parallel {
        $ErrorActionPreference = 'Stop'
        $destination = Join-Path $using:staging $_.path
        $escaped = ($_.path.Split('/') | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
        $url = "https://raw.githubusercontent.com/Albert-Weasker/niubigeo/$using:commit/$escaped"
        curl.exe -fsSL --retry 2 --connect-timeout 10 --max-time 30 -o $destination $url
        if ($LASTEXITCODE -ne 0 -or (git hash-object --no-filters -- $destination) -ne $_.sha) {
            throw "Could not verify NiubiGEO file $escaped"
        }
    } -ThrottleLimit 16
    Move-Item -LiteralPath $staging -Destination $geo
}

Push-Location -LiteralPath $geo
try {
    npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'NiubiGEO dependency installation failed.' }
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'NiubiGEO build failed.' }
} finally { Pop-Location }
Write-Host 'Ready. Run start.ps1 and open http://127.0.0.1:8790/.'
