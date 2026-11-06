# Developer helper: run one e2e file with Node 22 and write TAP output to tests/e2e-remote/.out/<name>.out
param([Parameter(Mandatory = $true)][string]$Name, [int]$Concurrency = 1)
$env:PATH = "C:\Users\sondt64\AppData\Local\nvm\v22.23.4;" + $env:PATH
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
New-Item -ItemType Directory -Force -Path "$PSScriptRoot\.out" | Out-Null
$out = "$PSScriptRoot\.out\$Name.out"
npx tsx --tsconfig server/tsconfig.json --test --test-concurrency=$Concurrency "tests/e2e-remote/$Name.test.ts" *> $out
Write-Output "exit=$LASTEXITCODE"
Select-String -Path $out -Pattern '^# (tests|pass|fail|cancelled|skipped)' | ForEach-Object { $_.Line }
