$ErrorActionPreference = 'Stop'
$originalEncoding = $OutputEncoding
try {
    $first = Read-Host 'Administrator password (at least 8 characters)' -AsSecureString
    $second = Read-Host 'Confirm administrator password' -AsSecureString
    $password = [System.Net.NetworkCredential]::new('', $first).Password
    if ($password -cne [System.Net.NetworkCredential]::new('', $second).Password) {
        throw 'The passwords do not match.'
    }
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $password | node.exe (Join-Path $PSScriptRoot 'setup-admin.mjs')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    $OutputEncoding = $originalEncoding
    if ($first) { $first.Dispose() }
    if ($second) { $second.Dispose() }
    Remove-Variable password -ErrorAction SilentlyContinue
}
