# Before Effects agent API from PowerShell (no extra tools needed).
# Turn on Agent access in Before Effects first (top bar → Agents), with a show open.
#   powershell -ExecutionPolicy Bypass -File tools\agent-examples\quickstart.ps1

$conn = Get-Content "$env:APPDATA\Before Effects\agent-api.json" | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $($conn.token)" }

function Call-BE([string]$method, $params = @{}, [string]$requestId = [guid]::NewGuid().ToString()) {
  $body = @{ method = $method; params = $params; requestId = $requestId } | ConvertTo-Json -Depth 20
  $r = Invoke-RestMethod -Method Post -Uri "$($conn.url)/v1/call" -Headers $headers -ContentType "application/json" -Body $body
  if (-not $r.ok) { throw "$($r.error.code): $($r.error.message)" }
  return $r
}

$show = (Call-BE "project.get").result
"Open show: $($show.name) (revision $($show.revision)), scene $($show.scene.name), $($show.building.areas) areas"

(Call-BE "areas.list").result.areas | Select-Object name, kind, @{ n = "bounds"; e = { "$($_.bounds.x),$($_.bounds.y) $($_.bounds.w)x$($_.bounds.h)" } } | Format-Table

# Capture the preview as the person sees it right now.
$cap = (Call-BE "preview.capture" @{}).result
"Preview saved: $($cap.path) ($($cap.width)x$($cap.height))"
