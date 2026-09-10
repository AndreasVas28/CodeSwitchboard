param(
  [ValidatePattern('^http://127\.0\.0\.1:\d+$')]
  [string]$BaseUrl,
  [string]$ModelsBase64,
  [switch]$Restore
)

$policyPath = 'HKCU:\SOFTWARE\Policies\Claude'
$markerName = 'CodeSwitchboardManaged'
$managedNames = @(
  'inferenceProvider',
  'inferenceCredentialKind',
  'inferenceGatewayBaseUrl',
  'inferenceGatewayApiKey',
  'inferenceGatewayAuthScheme',
  'modelDiscoveryEnabled',
  'inferenceModels'
)

if ($Restore) {
  if (-not (Test-Path -LiteralPath $policyPath)) { exit 0 }
  $current = Get-ItemProperty -LiteralPath $policyPath
  if ($current.$markerName -ne 1) {
    throw 'Claude Desktop policy is not managed by CodeSwitchboard and will not be changed.'
  }
  foreach ($name in $managedNames + $markerName) {
    Remove-ItemProperty -LiteralPath $policyPath -Name $name -ErrorAction SilentlyContinue
  }
  exit 0
}

if (-not $BaseUrl) { throw 'BaseUrl is required unless -Restore is used.' }
$ModelsJson = if ($ModelsBase64) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ModelsBase64)) } else { '["claude-sonnet-4-6"]' }
$models = @($ModelsJson | ConvertFrom-Json)
if ($models.Count -eq 0) { throw 'ModelsJson must be a non-empty JSON array.' }
foreach ($entry in $models) {
  $name = if ($entry -is [string]) { $entry } else { $entry.name }
  if (-not $name -or -not $name.Trim()) { throw 'Every model must have a non-empty name.' }
}

if (Test-Path -LiteralPath $policyPath) {
  $current = Get-ItemProperty -LiteralPath $policyPath
  if ($current.$markerName -ne 1) {
    foreach ($name in $managedNames) {
      if ($null -ne $current.$name) {
        throw 'Claude Desktop already has an administrator-managed inference policy. CodeSwitchboard will not overwrite it.'
      }
    }
  }
}

New-Item -Path $policyPath -Force | Out-Null
New-ItemProperty -Path $policyPath -Name 'inferenceProvider' -PropertyType String -Value 'gateway' -Force | Out-Null
New-ItemProperty -Path $policyPath -Name 'inferenceCredentialKind' -PropertyType String -Value 'static' -Force | Out-Null
New-ItemProperty -Path $policyPath -Name 'inferenceGatewayBaseUrl' -PropertyType String -Value $BaseUrl -Force | Out-Null
New-ItemProperty -Path $policyPath -Name 'inferenceGatewayApiKey' -PropertyType String -Value 'codeswitchboard-local' -Force | Out-Null
New-ItemProperty -Path $policyPath -Name 'inferenceGatewayAuthScheme' -PropertyType String -Value 'bearer' -Force | Out-Null
New-ItemProperty -Path $policyPath -Name 'modelDiscoveryEnabled' -PropertyType DWord -Value 1 -Force | Out-Null
New-ItemProperty -Path $policyPath -Name 'inferenceModels' -PropertyType String -Value $ModelsJson -Force | Out-Null
New-ItemProperty -Path $policyPath -Name $markerName -PropertyType DWord -Value 1 -Force | Out-Null
