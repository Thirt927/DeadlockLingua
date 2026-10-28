# Babel Tower - 构建脚本
# ------------------------------------------------------------------
# 流程:mod/panorama 源码 -> resourcecompiler 编译 -> vpkeditcli 打包 -> dist/pak01_dir.vpk
#
# 用法(任选):
#   powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Csdk12Root "<CSDK_DIR>"
#   powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Csdk12Root "<CSDK_DIR>" -Mode Source
#
# 参数:
#   -Csdk12Root   Reduced CSDK 12 根目录(必须能从中找到 resourcecompiler.exe)
#   -AddonName    临时 addon 名,默认 linguachat(全小写)
#   -Mode         Compiled(默认,编译+打包) | Source(只把源码复制到 dist/src 供检查)
#   -SkipPack     只编译不打包(调试用)
# 依赖工具:
#   - resourcecompiler.exe: 优先 CSDK12 的 game\bin_cs2\win64\,其次 bin_tools/bin/bin_server
#   - vpkeditcli.exe: 项目 tools\vpkeditcli.exe,或系统 PATH 中的 vpkedit
# 产物:dist\pak01_dir.vpk(直接放入 Deadlock 的 citadel\addons 目录)
# ------------------------------------------------------------------
[CmdletBinding()]
param(
  [string]$Csdk12Root = "",
  [string]$AddonName = "linguachat",
  [ValidateSet("Compiled", "Source")]
  [string]$Mode = "Compiled",
  [switch]$SkipPack
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ModDir = Join-Path $ProjectRoot "mod"
$DistDir = Join-Path $ProjectRoot "dist"
$ToolsDir = Join-Path $ProjectRoot "tools"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "[build] 错误: $msg" -ForegroundColor Red; exit 1 }

# ---------- 工具探测 ----------
function Find-ResourceCompiler {
  if (-not $Csdk12Root -or -not (Test-Path $Csdk12Root)) { return "" }
  $candidates = @(
    (Join-Path $Csdk12Root "game\bin_cs2\win64\resourcecompiler.exe"),
    (Join-Path $Csdk12Root "game\bin_tools\win64\resourcecompiler.exe"),
    (Join-Path $Csdk12Root "game\bin\win64\resourcecompiler.exe"),
    (Join-Path $Csdk12Root "game\bin_server\win64\resourcecompiler.exe")
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return ""
}

function Find-VpkEdit {
  $local = Join-Path $ToolsDir "vpkeditcli.exe"
  if (Test-Path $local) { return $local }
  $cmd = Get-Command vpkedit -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return ""
}

# ---------- 编译单个文件 ----------
# 注意:resourcecompiler 会把输出扩展名规范化为 .vxml_c/.vjs_c/.vcss_c
function Get-CompiledExtension($ext) {
  switch ($ext.ToLower()) {
    ".xml" { return "vxml_c" }
    ".js"  { return "vjs_c" }
    ".css" { return "vcss_c" }
    default { return $ext.TrimStart(".") + "_c" }
  }
}

function Compile-File($compiler, $contentFile, $gameFile) {
  $outDir = Split-Path -Parent $gameFile
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
  $contentFile = [System.IO.Path]::GetFullPath($contentFile)
  $gameFile = [System.IO.Path]::GetFullPath($gameFile)
  $args = @("-i", $contentFile, "-o", $gameFile)
  & $compiler @args | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Fail "resourcecompiler 编译失败: $contentFile (exit=$LASTEXITCODE)"
  }
  if (-not (Test-Path $gameFile)) {
    Fail "编译未产出文件: $gameFile"
  }
  Write-Host "   ok: $([System.IO.Path]::GetFileName($gameFile))"
}

# ---------- 拼接 lingua_chat 子系统(巨石拆分)----------
# 巨石已拆成 5 个同作用域片段(lct_identity/lct_logs/lct_channels/lct_settings/lct_diag),
# 按固定依赖顺序拼回单一 lingua_chat.js 再交给 resourcecompiler 编译。
# 片段缺一个即拼出不完整脚本 → 在此早失败,避免打进坏 VPK。
# 该步**幂等**:每次 build 都从 5 片段重拼 lingua_chat.js,所以 lingua_chat.js 永远以片段为准。
function Concat-LinguaChat {
  $parts = @(
    "lct_identity.js",   # State / 共享身份 / 工具 / 顶栏+SteamID+记分板采集
    "lct_settings.js",   # 配置/UI 偏好/loadUiConfig/saveUiConfig + LCT* 设置面板回调
    "lct_channels.js",   # 队列 / 分发 / BTIPC / HTTPS 面板 / 扫描循环
    "lct_logs.js",       # healthCheck / 桥状态 / 日志落盘
    "lct_diag.js"        # HUD 测试注入 / 探针 / boot / exportGlobal
  )
  $dir = Join-Path $ProjectRoot "mod\panorama\scripts"
  $missing = @()
  foreach ($p in $parts) { if (-not (Test-Path (Join-Path $dir $p))) { $missing += $p } }
  if ($missing.Count -gt 0) { Fail "lingua_chat 子系统片段缺失: $($missing -join ', ')" }
  $out = Join-Path $dir "lingua_chat.js"
  # lingua_chat.js 的头 15 行(原 IIFE 注释块)不属于任何片段,拼接时原样保留在最前
  $head = ([System.IO.File]::ReadLines($out) | Select-Object -First 15) -join "`r`n"
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.Append($head)
  [void]$sb.Append("`r`n")
  foreach ($p in $parts) {
    $body = [System.IO.File]::ReadAllText((Join-Path $dir $p), [System.Text.Encoding]::UTF8)
    [void]$sb.Append($body)
  }
  [void]$sb.Append("  boot();`r`n")
  [void]$sb.Append("})();`r`n`r`n`r`n`r`n`r`n")
  # 归一化为 CRLF(与其余 panorama 资源一致)
  $text = $sb.ToString().Replace("`r`n", "`n").Replace("`n", "`r`n")
  [System.IO.File]::WriteAllText($out, $text, (New-Object System.Text.UTF8Encoding($false)))
  Write-Step "已拼接 lingua_chat.js($($parts.Count) 个子系统片段)"
}

# ---------- 主流程 ----------
Write-Step "DeadlockLingua build (Mode=$Mode, Addon=$AddonName)"

if ($Mode -eq "Source") {
  # 先拼回 lingua_chat.js(Source 模式导出的是可编译/可部署的完整源码,不能漏拼接步)
  Concat-LinguaChat
  $srcOut = Join-Path $DistDir "src"
  if (Test-Path $srcOut) { Remove-Item $srcOut -Recurse -Force }
  Copy-Item $ModDir $srcOut -Recurse -Force
  Write-Step "源码已复制到 $srcOut"
  exit 0
}

$compiler = Find-ResourceCompiler
if (-not $compiler) {
  Fail "找不到 resourcecompiler.exe,请用 -Csdk12Root 指定 Reduced CSDK 12 根目录"
}
Write-Step "resourcecompiler: $compiler"

$contentAddon = Join-Path $Csdk12Root "content\citadel_addons\$AddonName"
$gameAddon = Join-Path $Csdk12Root "game\citadel_addons\$AddonName"

# 1. 同步源码到 CSDK addon 的 content 目录
# 逐文件覆写同步(不再递归 Remove-Item 再重建):
# 旧实现会在文件被编辑器/resourcecompiler 临时占用时直接失败(本次踩过:`Remove-Item` 对 `chat.xml` 报 Access denied)。
# 逐文件 copy 对单个文件占用更宽容,且不会误删用户手动加进 addon 目录的其他文件。
New-Item -ItemType Directory -Path $contentAddon -Force | Out-Null
Copy-Item $ModDir\* $contentAddon -Recurse -Force
Write-Step "源码已同步到 $contentAddon"

# 巨石拆分:先把 5 个子系统片段拼回 lingua_chat.js,再把它同步进 content addon 编译。
Concat-LinguaChat
Copy-Item (Join-Path $ProjectRoot "mod\panorama\scripts\lingua_chat.js") `
         (Join-Path $contentAddon "panorama\scripts\lingua_chat.js") -Force

# 2. 编译 panorama 资源
$contentPano = Join-Path $contentAddon "panorama"
if (-not (Test-Path $contentPano)) { Fail "content addon 中没有 panorama 目录" }

$files = Get-ChildItem $contentPano -Recurse -File | Where-Object {
  $_.Extension -in @(".xml", ".js", ".css")
}
if ($files.Count -eq 0) { Fail "没有可编译的 xml/js/css 文件" }
Write-Step "编译 $($files.Count) 个文件..."

foreach ($f in $files) {
  $rel = $f.FullName.Substring($contentPano.Length).TrimStart("\")
  $outRel = [System.IO.Path]::ChangeExtension($rel, (Get-CompiledExtension $f.Extension))
  $gameFile = Join-Path (Join-Path $gameAddon "panorama") $outRel
  Compile-File $compiler $f.FullName $gameFile
}

if ($SkipPack) {
  Write-Step "已跳过打包(SkipPack),编译产物在 $gameAddon"
  exit 0
}

# 3. 打包 VPK
$vpkEdit = Find-VpkEdit
if (-not $vpkEdit) {
  Fail "找不到 vpkeditcli.exe,请放入 tools\ 目录或加入 PATH(下载: https://github.com/craftablescience/VPKEdit/releases)"
}
Write-Step "vpkedit: $vpkEdit"
New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
$vpkOut = Join-Path $DistDir "pak01_dir.vpk"
if (Test-Path $vpkOut) { Remove-Item $vpkOut -Force }
Remove-Item (Join-Path $DistDir "pak01_*.vpk") -Force -ErrorAction SilentlyContinue

# vpkeditcli <输入目录> -o <输出.vpk> (将目录内文件全部打入单个 dir vpk)
& $vpkEdit $gameAddon -o $vpkOut --single-file --no-progress 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "vpkedit 打包失败 (exit=$LASTEXITCODE)" }
if (-not (Test-Path $vpkOut)) { Fail "打包未产出 $vpkOut" }

# 4. 校验关键资产
Write-Step "校验 VPK 内容..."
$listing = & $vpkEdit $vpkOut --file-tree 2>&1 | Out-String
$required = @("chat.vxml_c", "lingua_chat.vjs_c", "lingua_chat.vcss_c")
foreach ($r in $required) {
  if (-not ($listing -match [regex]::Escape($r))) {
    Fail "VPK 中缺少关键资产: $r"
  }
}

Write-Step "构建完成: $vpkOut"
Write-Host "安装:把 pak01_dir.vpk 复制到 Deadlock 的 game/citadel/addons 目录"
