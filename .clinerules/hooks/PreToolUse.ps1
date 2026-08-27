if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  '{"cancel":true,"errorMessage":"Blocked by LocalFi: Node.js is required to evaluate the agent safety hook."}'
  exit 0
}
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$guard = Join-Path $repositoryRoot "scripts/agent-private-path-guard.mjs"
Push-Location $repositoryRoot
$input | node $guard cline
$exitCode = $LASTEXITCODE
Pop-Location
exit $exitCode
