#Requires -Version 5.1
<#
.SYNOPSIS
    构建 LCTNative（x64 DLL）。

.DESCRIPTION
    检查 CMake 与 Visual Studio C++ 工具链，然后用 VS 生成器配置并编译
    native/CMakeLists.txt。构建产物固定输出到 native/build/。

    要求：Visual Studio 2022（或 2019）Build Tools / Community，安装
    「使用 C++ 的桌面开发」工作负载（含 MSVC 与 Windows 10/11 SDK），
    以及 CMake 3.21+（VS 自带的也可以用）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File native\build.ps1
    powershell -ExecutionPolicy Bypass -File native\build.ps1 -Configuration Debug -Clean
#>
[CmdletBinding()]
param(
    [ValidateSet('Release', 'Debug', 'RelWithDebInfo')]
    [string]$Configuration = 'Release',

    # 删除 build 目录后重新配置（工具链变了或缓存损坏时用）。
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Fail {
    param([string]$Message, [string[]]$Hints)
    Write-Host ""
    Write-Host "[错误] $Message" -ForegroundColor Red
    foreach ($hint in $Hints) {
        if ($hint) { Write-Host "       $hint" -ForegroundColor Yellow }
    }
    Write-Host ""
    exit 1
}

$projectRoot = $PSScriptRoot
$buildDir = Join-Path $projectRoot 'build'

Write-Host ""
Write-Host "LCTNative 构建脚本（x64 DLL）" -ForegroundColor Green
Write-Host ""

# ---------------------------------------------------------------------------
# 1. 查找 Visual Studio（必须带 C++ 工具链，否则没有 cl.exe / Windows SDK）
# ---------------------------------------------------------------------------
$programFilesX86 = ${env:ProgramFiles(x86)}
if (-not $programFilesX86) {
    Fail '当前系统没有 Program Files (x86) 目录，无法定位 Visual Studio。' @(
        '本项目只支持 64 位 Windows。'
    )
}

$vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) {
    Fail '没有找到 Visual Studio Installer（vswhere.exe），说明本机没有安装 Visual Studio。' @(
        '安装 Visual Studio 2022 Build Tools（或 Community），',
        '安装时勾选工作负载「使用 C++ 的桌面开发」（含 MSVC v143 + Windows SDK）。',
        '下载：https://visualstudio.microsoft.com/visual-cpp-build-tools/'
    )
}

$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$vsPath = @($vsPath) | Where-Object { $_ } | Select-Object -First 1
if (-not $vsPath) {
    Fail '找到了 Visual Studio，但没有安装 C++ 工具链（缺少 MSVC x64 生成工具）。' @(
        '打开 Visual Studio Installer → 修改 → 勾选「使用 C++ 的桌面开发」，',
        '确认其中包含「MSVC v143 - VS 2022 C++ x64/x86 生成工具」和 Windows SDK。'
    )
}

$vsVersion = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationVersion
$vsVersion = @($vsVersion) | Where-Object { $_ } | Select-Object -First 1
$vsMajor = 0
if ($vsVersion -match '^(\d+)\.') {
    $vsMajor = [int]$Matches[1]
}

$generator = switch ($vsMajor) {
    17 { 'Visual Studio 17 2022' }
    16 { 'Visual Studio 16 2019' }
    15 { 'Visual Studio 15 2017' }
    default { $null }
}

if (-not $generator) {
    Fail "无法识别 Visual Studio 版本（installationVersion = $vsVersion）。" @(
        '请安装 Visual Studio 2019 或 2022（Build Tools 或 Community）。'
    )
}

Write-Step "Visual Studio: $vsPath（$generator）"

# ---------------------------------------------------------------------------
# 2. 查找 CMake（优先 PATH，其次用 VS 自带的）
# ---------------------------------------------------------------------------
$cmake = $null
$cmakeCommand = Get-Command cmake.exe -ErrorAction SilentlyContinue
if ($cmakeCommand) {
    $cmake = $cmakeCommand.Source
} else {
    $bundled = Join-Path $vsPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
    if (Test-Path -LiteralPath $bundled) { $cmake = $bundled }
}

if (-not $cmake) {
    Fail '没有找到 cmake.exe（PATH 和 Visual Studio 自带目录里都没有）。' @(
        '安装 CMake 3.21+ 并加入 PATH：https://cmake.org/download/',
        '或者在 Visual Studio Installer 中勾选「C++ CMake tools for Windows」。'
    )
}

$cmakeVersionLine = (& $cmake --version | Select-Object -First 1)
if ($LASTEXITCODE -ne 0 -or -not $cmakeVersionLine) {
    Fail "无法运行 CMake：$cmake"
}

$cmakeVersion = $null
if ($cmakeVersionLine -match '(\d+)\.(\d+)\.(\d+)') {
    $cmakeVersion = [version]("$($Matches[1]).$($Matches[2]).$($Matches[3])")
}
if ($cmakeVersion -and $cmakeVersion -lt [version]'3.21.0') {
    Fail "CMake 版本过低（$cmakeVersionLine），需要 3.21 或更高。" @(
        'CMake 3.21+ 才提供 “Visual Studio 17 2022” 生成器。',
        '升级 CMake 后重试：https://cmake.org/download/'
    )
}

Write-Step "CMake: $cmake（$cmakeVersionLine）"

# ---------------------------------------------------------------------------
# 3. 配置并编译
# ---------------------------------------------------------------------------
if ($Clean -and (Test-Path -LiteralPath $buildDir)) {
    Write-Step "清理旧的 build 目录：$buildDir"
    Remove-Item -LiteralPath $buildDir -Recurse -Force
}

Write-Step "配置工程（生成器: $generator，架构: x64）"
& $cmake -S $projectRoot -B $buildDir -G $generator -A x64
if ($LASTEXITCODE -ne 0) {
    Fail 'CMake 配置失败。' @(
        '常见原因：缺少 Windows SDK、VS 工作负载不完整、或 build 目录缓存损坏。',
        '可以先清空后重试：powershell -ExecutionPolicy Bypass -File native\build.ps1 -Clean',
        '上面的 CMake 输出里通常有具体原因。'
    )
}

Write-Step "编译（配置: $Configuration）"
& $cmake --build $buildDir --config $Configuration --parallel
if ($LASTEXITCODE -ne 0) {
    Fail '编译失败。' @(
        '请按上面的编译器错误逐条修复；本脚本不会隐藏或吞掉错误输出。'
    )
}

$dllPath = Join-Path $buildDir 'LCTNative.dll'
if (-not (Test-Path -LiteralPath $dllPath)) {
    $altPath = Join-Path (Join-Path $buildDir $Configuration) 'LCTNative.dll'
    if (Test-Path -LiteralPath $altPath) { $dllPath = $altPath }
}
if (-not (Test-Path -LiteralPath $dllPath)) {
    Fail '编译流程结束，但没有找到 LCTNative.dll。' @(
        "请检查 $buildDir 目录下的实际输出位置。"
    )
}

Write-Host ""
Write-Host "==> 构建成功" -ForegroundColor Green
Write-Host "    DLL: $dllPath" -ForegroundColor Green
Write-Host ""
Write-Host "下一步：" -ForegroundColor Cyan
Write-Host "  1) （可选）在 DLL 同目录放 native.json，按需修改 bridgeUrl / chatRect / fontSize / maxLines / hotkey；不写则用默认值。"
Write-Host "  2) 先启动本地桥（例如 StartBridgeSilent.vbs），确认 http://127.0.0.1:8791/api/v1/health 可访问。"
Write-Host "  3) 游戏必须带 -condebug 启动（否则不会写 console.log，收不到聊天）。"
Write-Host "  4) 用你信任的注入器加载 DLL（本仓库不附带注入器），并让 DLL 常驻。"
Write-Host "  5) 日志：$env:TEMP\lct-native.log"
Write-Host ""
Write-Host "卸载：先调用导出函数 LCTNativeShutdown()（或直接退出游戏），不要直接 FreeLibrary。" -ForegroundColor Yellow
Write-Host ""
