# 把 dsh-image-guard 部署到 DSH profile 的 node_modules，并检查 loader 条目。
# 用法: pwsh -File deploy.ps1            # 默认装 desktop + web 两个 profile
#       pwsh -File deploy.ps1 -Profiles desktop
param([string[]]$Profiles = @("desktop", "web"))

$ErrorActionPreference = "Stop"
$src = $PSScriptRoot

foreach ($profile in $Profiles) {
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
  $profileDir = Join-Path (Join-Path $dshHome "profiles") $profile
  if (-not (Test-Path $profileDir)) { Write-Host "跳过（profile 不存在）: $profileDir" -ForegroundColor Yellow; continue }
  $dst = Join-Path $profileDir "node_modules\dsh-image-guard"

  New-Item -ItemType Directory -Force -Path (Join-Path $dst "lib") | Out-Null
  Copy-Item (Join-Path $src "package.json") $dst -Force
  Copy-Item (Join-Path $src "cordis.patch.yml") $dst -Force
  Copy-Item (Join-Path $src "lib\index.js") (Join-Path $dst "lib") -Force
  Write-Host "[$profile] 已部署 -> $dst"

  $entry = "file:///" + ($dst -replace '\\', '/') + "/lib/index.js"
  $out = node --input-type=module -e "import('$entry').then(m=>console.log('exports:',Object.keys(m).join(','))).catch(e=>console.log('IMPORT FAIL:',e.message))" 2>&1
  Write-Host "[$profile] 导入自检: $out"

  $patch = Join-Path $profileDir "cordis.patch.yml"
  $text = [IO.File]::ReadAllText($patch, [Text.Encoding]::UTF8)
  if ($text -match "image-guard") {
    Write-Host "[$profile] loader 条目: 已存在"
  } else {
    Write-Host "[$profile] loader 条目: 缺失！请把下面这段追加到 $patch" -ForegroundColor Yellow
    Write-Host @"

- insert:
  - id: image-guard
    name: ./node_modules/dsh-image-guard/lib/index.js
    config:
      enabled: true
      keepRecent: 12
"@
  }
  Write-Host ""
}

Write-Host "注意：desktop profile 才是 DSH Desktop 实际加载的那个（其日志在 `$env:APPDATA\DSH Desktop\logs\host\）。" -ForegroundColor Cyan
Write-Host "新增 loader 条目不会热加载（patchReload: live 只管已有条目的 config）——必须重启 DSH Desktop。" -ForegroundColor Cyan
Write-Host ""
Write-Host "验证（二选一）："
Write-Host '  Select-String -Path "$env:APPDATA\DSH Desktop\logs\host\dsh-$(Get-Date -f yyyy-MM-dd).log" -Pattern image-guard'
Write-Host '  Get-Content (Join-Path $env:USERPROFILE ".dsh\image-guard-status.json") -Encoding UTF8'
