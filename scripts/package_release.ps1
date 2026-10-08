param([string]$ProjectPath = '.')
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$artifacts = Join-Path $project 'artifacts'
New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
$temporaryDirectory = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$stage = Join-Path $temporaryDirectory ('fluxscale-package-' + [guid]::NewGuid().ToString('N'))
$root = Join-Path $stage 'fluxscale-0.5.0-rc.1'
try {
    $files = @('README.md', 'LICENSE', 'CHANGELOG.md', 'Cargo.toml', 'Cargo.lock', '.gitignore', '.gitattributes', '.dockerignore', 'fluxscale.local.toml', 'fluxscale.toml', 'openapi.json')
    foreach ($directory in @('src', 'dashboard-react/src', 'dashboard-react/public', 'dashboard-react/test', 'sdk/node/src', 'sdk/node/test', 'sdk/node/examples/express', 'docker/demo-service', 'deploy', 'connected', '.github')) {
        $files += Get-ChildItem -LiteralPath (Join-Path $project $directory) -Recurse -File |
            Where-Object { $_.FullName -notmatch '[/\\](node_modules|dist|data|__pycache__|artifacts)[/\\]' -and $_.BaseName -notmatch '_v\d|phase|backup|before|initial' -and $_.Extension -notin @('.env', '.log', '.pyc', '.sqlite', '.sqlite-wal', '.sqlite-shm') -and $_.Name -notin @('.env', 'agent.json', 'hero.png', 'vite.svg', 'react.svg') } |
            ForEach-Object { $_.FullName.Substring($project.Length + 1) }
    }
    foreach ($package in @('sdk/node', 'dashboard-react')) {
        $files += @("$package/package.json", "$package/package-lock.json", "$package/tsconfig.json")
    }
    $files += @('sdk/node/README.md', 'sdk/node/LICENSE', 'dashboard-react/index.html', 'dashboard-react/vite.config.ts', 'dashboard-react/tsconfig.app.json', 'dashboard-react/tsconfig.node.json', 'dashboard-react/eslint.config.js', 'dashboard-react/components.json')
    $files += Get-ChildItem -LiteralPath (Join-Path $project 'scripts') -File |
        Where-Object { $_.Name -ne 'simulate_spike.sh' -and ($_.Name -notmatch 'phase|_v\d' -or $_.Name -in @('verify_phase8a_v1.ps1', 'verify_phase7i_v1.ps1', 'verify_phase7d_v2.ps1')) } |
        ForEach-Object { 'scripts/' + $_.Name }
    $files += @('docs/OPERATIONS.md', 'docs/VERIFICATION.md', 'docs/INTEGRATION.md', 'docs/RELEASE.md', 'docs/LINKEDIN.md', 'docs/CONNECTED_AUTOSCALING.md', 'docs/CONNECTED_DEPLOYMENT.md', 'docs/DEMO.md', 'docs/assets/demo-analysis.png')
    $files += @('docs/assets/demo-result.json', 'docs/assets/demo-timeline.json', 'docs/assets/demo-scale-out.png', 'docs/assets/demo-fleet.png', 'docs/assets/demo-workloads.png')
    foreach ($relative in ($files | Sort-Object -Unique)) {
        $destination = Join-Path $root $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        [IO.File]::WriteAllBytes($destination, [IO.File]::ReadAllBytes((Join-Path $project $relative)))
    }
    $zip = Join-Path $artifacts 'fluxscale-0.5.0-rc.1-source.zip'
    Compress-Archive -Path $root -DestinationPath $zip -Force
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        if ($entries -match '/(node_modules|target|dist|data|\.fluxscale|__pycache__)/|tokens\.clixml|/\.env$|_(v\d|initial).*\.(rs|tsx?|css|json|toml)$|before|backup') { throw 'Excluded material leaked into source archive.' }
        foreach ($required in @('Cargo.lock', 'LICENSE', '.gitignore', 'sdk/node/src/resources.ts', 'deploy/compose.yaml', 'connected/server.mjs', 'scripts/record_demo.mjs', 'scripts/verify.ps1', 'openapi.json')) {
            if (-not ($entries | Where-Object { $_.EndsWith('/' + $required) })) { throw "Missing archive file: $required" }
        }
    } finally { $archive.Dispose() }
    $target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $env:LOCALAPPDATA 'FluxScale/target' }
    $binary = Join-Path $target 'release/fluxscale-core.exe'
    if (-not (Test-Path -LiteralPath $binary)) { throw 'Build cargo --release before packaging.' }
    Copy-Item -LiteralPath $binary -Destination (Join-Path $artifacts 'fluxscale-core-0.5.0-rc.1-windows-x64.exe') -Force
    $checksums = foreach ($name in @('fluxscale-node-0.1.0.tgz', 'fluxscale-0.5.0-rc.1-source.zip', 'fluxscale-core-0.5.0-rc.1-windows-x64.exe')) {
        $file = Join-Path $artifacts $name
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $name"
    }
    $checksums | Set-Content -LiteralPath (Join-Path $artifacts 'SHA256SUMS.txt') -Encoding ascii
    Write-Host "PASS: Checked source archive, SDK and Windows release artifacts in $artifacts"
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    if (-not $resolvedStage.StartsWith($temporaryDirectory, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolvedStage) -notlike 'fluxscale-package-*') {
        throw 'Refusing to clean a package stage outside the temporary directory.'
    }
    if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
}
