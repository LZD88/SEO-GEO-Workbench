$ErrorActionPreference = 'Stop'
$first = Read-Host 'Administrator password (at least 8 characters)' -MaskInput
$second = Read-Host 'Confirm administrator password' -MaskInput
if ($first -cne $second) { throw 'The passwords do not match.' }
try {
    $first | node (Join-Path $PSScriptRoot 'setup-admin.mjs')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Remove-Variable first,second -ErrorAction SilentlyContinue
}
