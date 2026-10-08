param([string]$ProjectPath = '.', [switch]$Connected)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$temporaryDirectory = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$context = Join-Path $temporaryDirectory ('fluxscale-deploy-build-' + [guid]::NewGuid().ToString('N'))
try {
    Write-Host 'Staging controller and console source for the deployment image...'
    $files = @('Cargo.toml', 'Cargo.lock', 'fluxscale.local.toml', 'deploy/Dockerfile', 'deploy/Dockerfile.dockerignore')
    if ($Connected) {
        $files += @('connected/Dockerfile', 'connected/Dockerfile.dockerignore', 'connected/package.json')
        $files += Get-ChildItem -LiteralPath (Join-Path $project 'connected') -File -Filter '*.mjs' | ForEach-Object { 'connected/' + $_.Name }
    }
    $files += Get-ChildItem -LiteralPath (Join-Path $project 'src') -File -Filter '*.rs' |
        Where-Object { $_.BaseName -notmatch '_v\d|phase|backup|before|initial' } |
        ForEach-Object { 'src/' + $_.Name }
    $files += @('dashboard-react/package.json', 'dashboard-react/package-lock.json', 'dashboard-react/tsconfig.json', 'dashboard-react/tsconfig.app.json', 'dashboard-react/tsconfig.node.json', 'dashboard-react/vite.config.ts', 'dashboard-react/index.html')
    foreach ($directory in @('dashboard-react/src', 'dashboard-react/public')) {
        $files += Get-ChildItem -LiteralPath (Join-Path $project $directory) -Recurse -File |
            Where-Object { $_.BaseName -notmatch '_v\d|phase|backup|before|initial' } |
            ForEach-Object { $_.FullName.Substring($project.Length + 1) }
    }
    foreach ($relative in $files) {
        $destination = Join-Path $context $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        [IO.File]::WriteAllBytes($destination, [IO.File]::ReadAllBytes((Join-Path $project $relative)))
    }
    Write-Host 'Building Linux controller and console image...'
    # Windows PowerShell can classify Docker's progress on stderr as an error when logging.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $dockerfile = if ($Connected) { 'connected/Dockerfile' } else { 'deploy/Dockerfile' }
        $image = if ($Connected) { 'fluxscale/connected:0.1.0' } else { 'fluxscale/controller:0.5.0-rc.1' }
        & docker build -f (Join-Path $context $dockerfile) -t $image $context
        $buildExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($buildExitCode -ne 0) { throw 'Deployment image build failed.' }
} finally {
    $resolvedContext = [IO.Path]::GetFullPath($context)
    if (-not $resolvedContext.StartsWith($temporaryDirectory, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolvedContext) -notlike 'fluxscale-deploy-build-*') {
        throw 'Refusing to clean a context outside the temporary directory.'
    }
    if (Test-Path -LiteralPath $resolvedContext) { Remove-Item -LiteralPath $resolvedContext -Recurse -Force }
}
