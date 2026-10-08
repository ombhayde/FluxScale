param([string]$ProjectPath = '.')
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$temporaryDirectory = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$context = Join-Path $temporaryDirectory ('fluxscale-image-' + [guid]::NewGuid().ToString('N'))
try {
    # Migrated Desktop files can be reparse points; stage ordinary byte copies for BuildKit.
    foreach ($relative in @('.dockerignore', 'sdk/node/package.json', 'sdk/node/package-lock.json', 'sdk/node/tsconfig.json', 'sdk/node/src/index.ts', 'sdk/node/src/resources.ts', 'sdk/node/examples/express/package.json', 'sdk/node/examples/express/package-lock.json', 'sdk/node/examples/express/server.mjs', 'sdk/node/examples/express/workloads.mjs', 'sdk/node/examples/express/Dockerfile')) {
        $destination = Join-Path $context $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        [IO.File]::WriteAllBytes($destination, [IO.File]::ReadAllBytes((Join-Path $project $relative)))
    }
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & docker build -f (Join-Path $context 'sdk/node/examples/express/Dockerfile') -t fluxscale/express-demo:v1 $context
        $buildExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($buildExitCode -ne 0) { throw 'SDK workload image build failed.' }
} finally {
    $resolvedContext = [IO.Path]::GetFullPath($context)
    if (-not $resolvedContext.StartsWith($temporaryDirectory, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolvedContext) -notlike 'fluxscale-image-*') {
        throw 'Refusing to clean a build context outside the temporary directory.'
    }
    if (Test-Path -LiteralPath $resolvedContext) { Remove-Item -LiteralPath $resolvedContext -Recurse -Force }
}
