# Babel Tower - 开机自启安装/卸载脚本
# ------------------------------------------------------------------
# 目标:不再需要 StartDeadlock.bat —— 桥随 Windows 登录静默启动,
#      游戏关闭时桥自动退出(由 bridge_server.js 的进程监视实现)。
#
# 方式:注册表 HKCU Run 键 + wscript 无窗口运行项目内 vbs
#      (不依赖启动文件夹,避免已知文件夹重定向问题)
#
# 用法(当前用户级,无需管理员):
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Action Install
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Action Remove
# ------------------------------------------------------------------
[CmdletBinding()]
param(
  [ValidateSet("Install", "Remove")]
  [string]$Action = "Install"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$ValueName = "BabelTowerBridge"
$VbsPath = Join-Path $Root "scripts\babel_bridge_autostart.vbs"
# 启动项"禁用标记"位置:任务管理器/联想电脑管家等"禁用开机启动"时在这里写禁用标记,
# 即使 Run 键值还在,系统也会跳过;只写回 Run 键会"设置不回去"。
$ApprovedKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"

# 清除禁用标记(删除 = 恢复默认启用;不存在的项系统按启用处理)
function Clear-ApprovedFlag {
  if (Test-Path $ApprovedKey) {
    $p = Get-ItemProperty -Path $ApprovedKey -Name $ValueName -ErrorAction SilentlyContinue
    if ($p) {
      Remove-ItemProperty -Path $ApprovedKey -Name $ValueName -ErrorAction SilentlyContinue
      Write-Host "已清除开机自启禁用标记(StartupApproved)。"
    }
  }
}

if ($Action -eq "Install") {
  # 静态 vbs(仓库里已有一份,逻辑与 StartDeadlock.bat 一致:先 cd 到项目根、优先便携 node)。
  # 不再运行时动态生成——旧版动态生成的那一份与静态版逻辑不一致(不 cd、路径拼接易翻车),
  # 且生成的文件被 .gitignore 忽略,跨机器装自启就缺文件。改为统一用仓库自带的那份。
  if (-not (Test-Path $VbsPath)) { throw "找不到无窗口启动脚本: $VbsPath (应由 scripts\babel_bridge_autostart.vbs 提供)" }


  # 注册到 HKCU Run(wscript 静默执行 vbs)
  Set-ItemProperty -Path $RunKey -Name $ValueName -Value ('"' + (Join-Path $env:WINDIR "System32\wscript.exe") + '" "' + $VbsPath + '"')
  # 清掉安全软件/任务管理器写入的"禁用标记",避免 Run 键在但自启不生效
  Clear-ApprovedFlag
  $installed = (Get-ItemProperty -Path $RunKey -Name $ValueName).$ValueName
  Write-Host "已注册开机自启(Run 键): $installed"
  Write-Host ""
  Write-Host "之后直接 Steam 启动 Deadlock 即可;游戏退出时桥自动关闭。"
  Write-Host "卸载: powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Action Remove"
} else {
  $removed = $false
  if (Test-Path $RunKey) {
    $p = Get-ItemProperty -Path $RunKey -Name $ValueName -ErrorAction SilentlyContinue
    if ($p) {
      Remove-ItemProperty -Path $RunKey -Name $ValueName -ErrorAction SilentlyContinue
      $removed = $true
    }
  }
  # 卸载时也清掉禁用标记,保持环境干净
  if (Test-Path $ApprovedKey) {
    $p = Get-ItemProperty -Path $ApprovedKey -Name $ValueName -ErrorAction SilentlyContinue
    if ($p) {
      Remove-ItemProperty -Path $ApprovedKey -Name $ValueName -ErrorAction SilentlyContinue
      $removed = $true
    }
  }
  if ($removed) { Write-Host "已移除开机自启。" } else { Write-Host "未安装过开机自启。" }
}
