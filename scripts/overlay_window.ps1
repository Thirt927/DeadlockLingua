# DeadlockLingua native overlay window (WPF)
#
# Why not a browser window: Edge/Chrome --app windows always paint an opaque
# client-area background, so CSS opacity can only fade the page, never make the
# window itself see-through. WPF supports AllowsTransparency + Topmost, which is
# what a real game overlay (like an on-screen keyboard) needs.
#
# Two windows, one process:
#   Window  : the normal panel - chat list, compose box, settings, draggable,
#             auto-collapses into a thin tab on whichever screen edge it is
#             dropped nearest to.
#   Danmaku : a click-through full-width band that draws only outlined text
#             (no background box), for "bullet chat" style subtitles.
#
# Layout/animation choices follow common live-caption/danmaku practice:
# stacked fade in/out instead of scrolling (moving text is much harder to read),
# and white text with a black outline instead of a background block (an outline
# keeps contrast on any background without covering the game).
#
# NOTE: this file MUST stay UTF-8 with BOM, otherwise PowerShell 5.1 reads it as
# ANSI and every Chinese string turns into mojibake.

param(
  [string]$Bridge = "http://127.0.0.1:8791",
  [int]$PollMs = 1200,
  [int]$StartupGraceMs = 8000
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

Add-Type -Namespace Win -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
[DllImport("user32.dll", SetLastError=true)] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
'@

# Only one overlay at a time; a second launch just exits.
$script:Mutex = New-Object System.Threading.Mutex($false, "Local\DeadlockLinguaOverlay")
if (-not $script:Mutex.WaitOne(0)) { exit 0 }

# ============================================================ config access
function Invoke-ApiGet([string]$Url) {
  $wc = New-Object System.Net.WebClient
  $wc.Encoding = [System.Text.Encoding]::UTF8
  try { return ($wc.DownloadString($Url) | ConvertFrom-Json) } finally { $wc.Dispose() }
}

function Invoke-ApiPost([string]$Url, $Payload) {
  $wc = New-Object System.Net.WebClient
  $wc.Encoding = [System.Text.Encoding]::UTF8
  $wc.Headers["Content-Type"] = "application/json; charset=utf-8"
  try {
    $body = $Payload | ConvertTo-Json -Compress -Depth 6
    return ($wc.UploadString($Url, "POST", $body) | ConvertFrom-Json)
  } finally { $wc.Dispose() }
}

function ConvertTo-Brush([string]$hex, [string]$fallback) {
  $c = [System.Windows.Media.BrushConverter]::new()
  try {
    $b = $c.ConvertFromString($hex)
    if ($b) { return $b }
  } catch {}
  return $c.ConvertFromString($fallback)
}

# Apply the opacity to the panel FILL only, so the text stays fully opaque
# (fading the whole window would make the chat unreadable).
function New-PanelBrush([string]$hex, [double]$alpha) {
  $h = ([string]$hex) -replace "^#", ""
  if ($h.Length -eq 8) { $h = $h.Substring(2) }
  if ($h.Length -ne 6 -or $h -notmatch "^[0-9a-fA-F]{6}$") { $h = "0D0F14" }
  $a = [int][Math]::Round([Math]::Min(1.0, [Math]::Max(0.0, $alpha)) * 255)
  return ConvertTo-Brush ("#{0:X2}{1}" -f $a, $h) "#D90D0F14"
}

# ============================================================ design tokens
# Grounded in the game's own world - 1930s occult-noir New York: oxidised brass,
# verdigris on copper, lamplight on wet stone. Deliberately NOT the generic
# "near-black + one bright accent" default, and without the "identical rounded
# card + identical soft shadow on everything" kit:
#   - ONE window-level shadow; rows are separated by hairlines, not boxes
#   - colour is assigned by function (action / other people / you / error),
#     never as decoration
#   - type does the work: the foreign original is set in an industrial condensed
#     face, the translation in a humanist UI face, so the two never blur together
$script:T = @{
  Surface  = "#131920"
  Surface2 = "#1B222B"
  Line     = "#2C353F"
  Line2    = "#3A4551"
  Ink      = "#E9E3D5"
  Ink2     = "#A9B1BD"
  Ink3     = "#6E7785"
  Brass    = "#C9A44E"
  BrassDim = "#6B5B2E"
  Patina   = "#5FA08B"
  Own      = "#7EA9CC"
  Danger   = "#CB6A5F"
  Ok       = "#6FB98A"
}
# Latin gets Bahnschrift SemiCondensed (ships with Windows, DIN-adjacent);
# CJK falls through to Microsoft YaHei UI. Verified present on this machine.
$script:F = "Bahnschrift SemiCondensed, Microsoft YaHei UI"

# ============================================================ main window XAML
$script:Xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="DeadlockLingua" Width="340" Height="470"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize"
        WindowStartupLocation="Manual" SnapsToDevicePixels="True"
        TextOptions.TextFormattingMode="Ideal" UseLayoutRounding="True"
        FontFamily="$($F)" FontSize="12" Foreground="$($T.Ink)">
  <Window.Resources>
    <!-- Quiet ghost buttons: four filled boxes in a 20px-tall strip was the
         loudest thing in the window and it carried no hierarchy. Only the
         send action stays filled - that is where the boldness is spent. -->
    <Style TargetType="Button">
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="Foreground" Value="$($T.Ink2)"/>
      <Setter Property="BorderBrush" Value="Transparent"/>
      <Setter Property="Padding" Value="6,3"/>
      <Setter Property="FontSize" Value="11.5"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="B" Background="{TemplateBinding Background}"
                    BorderBrush="{TemplateBinding BorderBrush}"
                    BorderThickness="1" CornerRadius="4"
                    Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="B" Property="Background" Value="$($T.Surface2)"/>
                <Setter Property="Foreground" Value="$($T.Ink)"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter Property="Opacity" Value="0.45"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="KeyAct" TargetType="Button">
      <Setter Property="Foreground" Value="$($T.Brass)"/>
    </Style>
    <Style x:Key="SolidAct" TargetType="Button">
      <Setter Property="Foreground" Value="#161A16"/>
      <Setter Property="Background" Value="$($T.Brass)"/>
      <Setter Property="BorderBrush" Value="$($T.Brass)"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
    </Style>

    <!-- WPF's stock TextBox / CheckBox / ComboBox / Slider templates paint
         light system chrome no matter what the window background is. That is
         exactly why the settings sheet read as pasted in from another app: a
         near-black panel with white input wells, a white tick box and a white
         dropdown. These templates put every control on the same dark palette. -->
    <Style TargetType="TextBox">
      <Setter Property="Background" Value="$($T.Surface2)"/>
      <Setter Property="Foreground" Value="$($T.Ink)"/>
      <Setter Property="BorderBrush" Value="$($T.Line2)"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="CaretBrush" Value="$($T.Brass)"/>
      <Setter Property="SelectionBrush" Value="$($T.BrassDim)"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Padding" Value="5,3"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="TextBox">
            <Border Background="{TemplateBinding Background}"
                    BorderBrush="{TemplateBinding BorderBrush}"
                    BorderThickness="{TemplateBinding BorderThickness}"
                    CornerRadius="4">
              <ScrollViewer x:Name="PART_ContentHost"
                            Margin="{TemplateBinding Padding}"
                            VerticalScrollBarVisibility="{TemplateBinding VerticalScrollBarVisibility}"/>
            </Border>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style TargetType="CheckBox">
      <Setter Property="Foreground" Value="$($T.Ink)"/>
      <Setter Property="FontSize" Value="11.5"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="CheckBox">
            <StackPanel Orientation="Horizontal" Background="Transparent">
              <Border x:Name="Box" Width="15" Height="15" CornerRadius="3"
                      Background="$($T.Surface2)" BorderBrush="$($T.Line2)"
                      BorderThickness="1" VerticalAlignment="Center">
                <Path x:Name="Tick" Data="M 2.5,7.5 L 6,11 L 12.5,3.5"
                      Stroke="$($T.Brass)" StrokeThickness="1.8"
                      StrokeStartLineCap="Round" StrokeEndLineCap="Round"
                      Visibility="Collapsed"/>
              </Border>
              <ContentPresenter Margin="7,0,0,0" VerticalAlignment="Center"/>
            </StackPanel>
            <ControlTemplate.Triggers>
              <Trigger Property="IsChecked" Value="True">
                <Setter TargetName="Tick" Property="Visibility" Value="Visible"/>
                <Setter TargetName="Box" Property="BorderBrush" Value="$($T.Brass)"/>
              </Trigger>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Box" Property="BorderBrush" Value="$($T.Brass)"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="ComboToggle" TargetType="ToggleButton">
      <Setter Property="Focusable" Value="False"/>
      <Setter Property="ClickMode" Value="Press"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ToggleButton">
            <Border Background="$($T.Surface2)" BorderBrush="$($T.Line2)"
                    BorderThickness="1" CornerRadius="4">
              <Path Data="M 0,0 L 4.5,4.5 L 9,0" Stroke="$($T.Ink3)" StrokeThickness="1.4"
                    HorizontalAlignment="Right" VerticalAlignment="Center" Margin="0,0,9,0"/>
            </Border>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style TargetType="ComboBoxItem">
      <Setter Property="Background" Value="$($T.Surface2)"/>
      <Setter Property="Foreground" Value="$($T.Ink)"/>
      <Setter Property="Padding" Value="8,5"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ComboBoxItem">
            <Border x:Name="B" Background="{TemplateBinding Background}"
                    Padding="{TemplateBinding Padding}">
              <ContentPresenter/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsHighlighted" Value="True">
                <Setter TargetName="B" Property="Background" Value="$($T.Line)"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style TargetType="ComboBox">
      <Setter Property="Foreground" Value="$($T.Ink)"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ComboBox">
            <Grid>
              <ToggleButton x:Name="Toggle" Style="{StaticResource ComboToggle}"
                            IsChecked="{Binding IsDropDownOpen, Mode=TwoWay, RelativeSource={RelativeSource TemplatedParent}}"/>
              <ContentPresenter IsHitTestVisible="False"
                                Content="{TemplateBinding SelectionBoxItem}"
                                ContentTemplate="{TemplateBinding SelectionBoxItemTemplate}"
                                Margin="8,4,26,4" VerticalAlignment="Center"/>
              <Popup x:Name="PART_Popup" AllowsTransparency="True" Placement="Bottom"
                     IsOpen="{TemplateBinding IsDropDownOpen}" Focusable="False"
                     PopupAnimation="Fade">
                <Border Background="$($T.Surface2)" BorderBrush="$($T.Line2)"
                        BorderThickness="1" CornerRadius="4"
                        MinWidth="{TemplateBinding ActualWidth}" MaxHeight="240">
                  <ScrollViewer>
                    <ItemsPresenter/>
                  </ScrollViewer>
                </Border>
              </Popup>
            </Grid>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style TargetType="Slider">
      <Setter Property="Foreground" Value="$($T.Brass)"/>
      <Setter Property="Background" Value="$($T.Line2)"/>
    </Style>
  </Window.Resources>

  <Border x:Name="Root" CornerRadius="10" Background="$($T.Surface)"
          BorderBrush="$($T.Line)" BorderThickness="1">
    <Border.Effect>
      <DropShadowEffect BlurRadius="18" ShadowDepth="0" Opacity="0.7" Color="#000000"/>
    </Border.Effect>
    <Grid Margin="1">
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="1"/>
        <RowDefinition Height="*"/>
      </Grid.RowDefinitions>

      <!-- Status is the one thing worth reading in this strip, so it sits first;
           the wordmark is only there because the window has no title bar. -->
      <Grid x:Name="Header" Grid.Row="0" Margin="11,8,9,7" Background="Transparent">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <TextBlock Grid.Column="0" Text="Lingua" Foreground="$($T.Brass)"
                   FontWeight="SemiBold" FontSize="12.5" VerticalAlignment="Center"/>
        <Ellipse x:Name="Dot" Grid.Column="1" Width="6" Height="6" Fill="$($T.Ink3)"
                 Margin="9,0,0,0" VerticalAlignment="Center"/>
        <TextBlock x:Name="StatusText" Grid.Column="2" Text="连接中…" Foreground="$($T.Ink3)"
                   Margin="6,0,6,0" VerticalAlignment="Center" FontSize="11.5"
                   TextTrimming="CharacterEllipsis"/>
        <Button x:Name="SettingsBtn" Grid.Column="3" Content="设置" Style="{StaticResource KeyAct}" ToolTip="打开设置"/>
        <Button x:Name="PinBtn" Grid.Column="4" Content="固定" Margin="2,0,0,0" ToolTip="关闭贴边自动收起"/>
        <Button x:Name="CollapseBtn" Grid.Column="5" Content="收起" Margin="2,0,0,0"/>
        <Button x:Name="CloseBtn" Grid.Column="6" Content="&#x2715;" Margin="2,0,0,0"/>
      </Grid>
      <Border Grid.Row="1" Background="$($T.Line)"/>

      <Grid x:Name="ChatPage" Grid.Row="2">
        <Grid.RowDefinitions>
          <RowDefinition Height="*"/>
          <RowDefinition Height="Auto"/>
        </Grid.RowDefinitions>
        <ScrollViewer x:Name="MsgScroll" Grid.Row="0" Margin="11,4,9,0"
                      VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled">
          <StackPanel x:Name="MsgList">
            <TextBlock x:Name="EmptyText" Text="等待游戏内聊天…&#x0a;&#x0a;需要先启动 Deadlock 并进入对局/大厅。"
                       Foreground="$($T.Ink3)" TextAlignment="Center" TextWrapping="Wrap" Margin="0,24,0,0"/>
          </StackPanel>
        </ScrollViewer>
        <StackPanel x:Name="Footer" Grid.Row="1" Margin="11,8,9,9">
          <TextBox x:Name="Input" Height="42" AcceptsReturn="True" TextWrapping="Wrap"
                   Background="$($T.Surface2)" Foreground="$($T.Ink)" BorderBrush="$($T.Line2)"
                   CaretBrush="$($T.Brass)" SelectionBrush="$($T.BrassDim)" Padding="6,4"
                   FontSize="12.5" VerticalScrollBarVisibility="Auto"/>
          <Grid Margin="0,6,0,0">
            <Grid.ColumnDefinitions>
              <ColumnDefinition Width="Auto"/>
              <ColumnDefinition Width="*"/>
            </Grid.ColumnDefinitions>
            <Button x:Name="SendBtn" Grid.Column="0" Content="翻译并复制" Style="{StaticResource SolidAct}"/>
            <TextBlock x:Name="Hint" Grid.Column="1" Text="" Foreground="$($T.Ink3)"
                       Margin="8,0,0,0" VerticalAlignment="Center" FontSize="11"
                       TextTrimming="CharacterEllipsis"/>
          </Grid>
          <Border x:Name="OutBox" Visibility="Collapsed" Margin="0,6,0,0"
                  Background="$($T.Surface2)" BorderBrush="$($T.Line2)"
                  BorderThickness="1" CornerRadius="4" Padding="7,5">
            <StackPanel>
              <TextBlock x:Name="OutText" TextWrapping="Wrap" Foreground="$($T.Ink)" FontSize="13"/>
              <Button x:Name="CopyBtn" Content="复制" HorizontalAlignment="Left" Margin="0,6,0,0"/>
            </StackPanel>
          </Border>
        </StackPanel>
      </Grid>

      <Grid x:Name="SettingsPage" Grid.Row="2" Visibility="Collapsed">
        <Grid.RowDefinitions>
          <RowDefinition Height="*"/>
          <RowDefinition Height="Auto"/>
        </Grid.RowDefinitions>
        <ScrollViewer Grid.Row="0" Margin="11,4,9,0"
                      VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled">
          <StackPanel x:Name="SettingsList"/>
        </ScrollViewer>
        <StackPanel Grid.Row="1" Margin="11,8,9,9">
          <TextBlock x:Name="SettingsHint" Text="" Foreground="$($T.Ink3)" FontSize="11"
                     TextWrapping="Wrap"/>
          <StackPanel Orientation="Horizontal" Margin="0,6,0,0">
            <Button x:Name="SaveCfgBtn" Content="保存" Style="{StaticResource SolidAct}"/>
            <Button x:Name="ReloadCfgBtn" Content="重载" Margin="6,0,0,0"/>
            <Button x:Name="CloseSettingsBtn" Content="返回聊天" Margin="2,0,0,0"/>
          </StackPanel>
          <Button x:Name="AdjustSubBtn" Content="调整字幕位置(拖动)" Margin="0,6,0,0"/>
        </StackPanel>
      </Grid>
    </Grid>
  </Border>
</Window>
"@

$script:Window = [System.Windows.Markup.XamlReader]::Parse($script:Xaml)
foreach ($n in @("Root","Header","Dot","StatusText","SettingsBtn","PinBtn","CollapseBtn","CloseBtn",
                 "ChatPage","MsgScroll","MsgList","EmptyText","Footer","Input","SendBtn","Hint",
                 "OutBox","OutText","CopyBtn","SettingsPage","SettingsList","SettingsHint",
                 "SaveCfgBtn","ReloadCfgBtn","CloseSettingsBtn","AdjustSubBtn")) {
  Set-Variable -Name $n -Scope Script -Value $script:Window.FindName($n)
}

# ============================================================ subtitle layer
# Chat-feed style caption layer: a transparent, frameless window holding a stack
# of message chips, anchored anywhere on screen. Modelled on stream chat
# overlays (translucent chips, per-speaker identity), but WITHOUT the generic
# "identical card + identical shadow on everything" look: no drop shadows, the
# monogram carries speaker identity, and the translation is the only thing at
# full contrast.
$script:DmXaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="DeadlockLinguaSubtitle" Width="400" Height="300"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize"
        WindowStartupLocation="Manual" Focusable="False"
        TextOptions.TextFormattingMode="Ideal"
        FontFamily="$($F)">
  <Grid x:Name="SubFrame" Background="Transparent">
    <StackPanel x:Name="SubList" VerticalAlignment="Bottom"/>
    <Border x:Name="SubEditFrame" Visibility="Collapsed" Background="#26000000"
            BorderBrush="$($T.Brass)" BorderThickness="1" CornerRadius="8">
      <TextBlock x:Name="SubEditHint" Text="拖动放置 · 松手记住位置"
                 Foreground="$($T.Brass)" FontSize="12" FontWeight="SemiBold"
                 HorizontalAlignment="Center" VerticalAlignment="Top" Margin="0,6,0,0"/>
    </Border>
  </Grid>
</Window>
"@

$script:DmWindow = [System.Windows.Markup.XamlReader]::Parse($script:DmXaml)
$script:DmList = $script:DmWindow.FindName("SubList")
$script:DmFrame = $script:DmWindow.FindName("SubFrame")
$script:DmEditFrame = $script:DmWindow.FindName("SubEditFrame")
$script:DmEditHint = $script:DmWindow.FindName("SubEditHint")

# ============================================================ runtime state
$script:Cfg = $null
$script:Ov = $null
$script:Edge = "right"
$script:AutoHide = $true
$script:AwakeMs = 6000
$script:TabWidth = 8
$script:MouseIn = $false
$script:InputFocused = $false
$script:Ready = $false
$script:Dragging = $false
$script:Nodes = @{}
$script:LastSeq = 0
$script:LastStatus = ""
$script:DmItems = @()
$script:SubNodes = @{}
$script:SubSeen = @{}
$script:SubEditMode = $false
$script:Ctl = @{}
$script:CfgTouched = @{}

$script:AnimTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:AnimTimer.Interval = [TimeSpan]::FromMilliseconds(12)
$script:AnimFromL = 0.0; $script:AnimToL = 0.0
$script:AnimFromT = 0.0; $script:AnimToT = 0.0
$script:AnimStep = 0
$script:Animating = $false

$script:AwakeTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:AwakeTimer.Interval = [TimeSpan]::FromMilliseconds(6000)
$script:EaseTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:EaseTimer.Interval = [TimeSpan]::FromMilliseconds(40)
$script:StartTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:StartTimer.Interval = [TimeSpan]::FromMilliseconds($StartupGraceMs)
$script:PollTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:PollTimer.Interval = [TimeSpan]::FromMilliseconds($PollMs)

# ============================================================ edge docking
# The window always ends up flush against one of the four work-area edges.
# "Expanded" = fully on screen, "collapsed" = only a thin tab pokes out.
function Get-EdgeTarget([bool]$expanded) {
  $wa = [System.Windows.SystemParameters]::WorkArea
  $w = $script:Window.Width
  $h = $script:Window.Height
  $l = $script:Window.Left
  $t = $script:Window.Top
  switch ($script:Edge) {
    "left" {
      $l = $wa.Left
      if (-not $expanded) { $l = $wa.Left - ($w - $script:TabWidth) }
      $t = [Math]::Min([Math]::Max($t, $wa.Top), $wa.Bottom - $h)
    }
    "right" {
      $l = $wa.Right - $w
      if (-not $expanded) { $l = $wa.Right - $script:TabWidth }
      $t = [Math]::Min([Math]::Max($t, $wa.Top), $wa.Bottom - $h)
    }
    "top" {
      $t = $wa.Top
      if (-not $expanded) { $t = $wa.Top - ($h - $script:TabWidth) }
      $l = [Math]::Min([Math]::Max($l, $wa.Left), $wa.Right - $w)
    }
    "bottom" {
      $t = $wa.Bottom - $h
      if (-not $expanded) { $t = $wa.Bottom - $script:TabWidth }
      $l = [Math]::Min([Math]::Max($l, $wa.Left), $wa.Right - $w)
    }
  }
  return @{ L = $l; T = $t }
}

function Move-To([double]$l, [double]$t) {
  $script:AnimFromL = $script:Window.Left
  $script:AnimFromT = $script:Window.Top
  $script:AnimToL = $l
  $script:AnimToT = $t
  $script:AnimStep = 0
  if (-not $script:Animating) { $script:Animating = $true; $script:AnimTimer.Start() }
}

function Expand-Window() {
  if ($script:Dragging) { return }
  $script:AwakeTimer.Stop()
  $p = Get-EdgeTarget $true
  Move-To $p.L $p.T
}

function Collapse-Window() {
  if ($script:Dragging) { return }
  $script:AwakeTimer.Stop()
  $p = Get-EdgeTarget $false
  Move-To $p.L $p.T
}

function Wake-Window() {
  if (-not $script:AutoHide) { return }
  $p = Get-EdgeTarget $true
  Move-To $p.L $p.T
  $script:AwakeTimer.Stop()
  $script:AwakeTimer.Start()
}

# Snap to whichever screen edge the window centre is closest to, then persist it.
function Snap-ToNearestEdge() {
  $wa = [System.Windows.SystemParameters]::WorkArea
  $cx = $script:Window.Left + $script:Window.Width / 2
  $cy = $script:Window.Top + $script:Window.Height / 2
  $d = @{
    left   = $cx - $wa.Left
    right  = $wa.Right - $cx
    top    = $cy - $wa.Top
    bottom = $wa.Bottom - $cy
  }
  $best = "right"; $bestV = [double]::MaxValue
  foreach ($k in @("left", "right", "top", "bottom")) {
    if ($d[$k] -lt $bestV) { $bestV = $d[$k]; $best = $k }
  }
  $script:Edge = $best
  $p = Get-EdgeTarget $true
  $script:Window.Left = $p.L
  $script:Window.Top = $p.T
  Save-Overlay @{ edge = $best }
}

$script:AnimTimer.Add_Tick({
  $script:AnimStep++
  $t = [Math]::Min(1.0, $script:AnimStep / 9.0)
  $e = 1 - [Math]::Pow(1 - $t, 3)
  $script:Window.Left = $script:AnimFromL + ($script:AnimToL - $script:AnimFromL) * $e
  $script:Window.Top = $script:AnimFromT + ($script:AnimToT - $script:AnimFromT) * $e
  if ($t -ge 1) { $script:AnimTimer.Stop(); $script:Animating = $false }
})

$script:AwakeTimer.Add_Tick({
  $script:AwakeTimer.Stop()
  if ($script:AutoHide -and -not $script:MouseIn -and -not $script:InputFocused) { Collapse-Window }
})

# ============================================================ message list
# Same chip language as the caption layer (monogram + name + original +
# translation) so the two windows read as one product. No per-message card and
# no per-message shadow - rows are separated by a hairline, which is what makes
# a dense list scannable instead of a stack of identical boxes.
function New-MessageNode($m) {
  $own = [bool]$m.own
  $accent = if ($own) { $script:T.Own } else { $script:T.Patina }

  $wrap = New-Object System.Windows.Controls.Border
  $wrap.BorderThickness = New-Object System.Windows.Thickness(0, 0, 0, 1)
  $wrap.BorderBrush = ConvertTo-Brush $script:T.Line "#2C353F"
  $wrap.Padding = New-Object System.Windows.Thickness(0, 9, 0, 9)

  $grid = New-Object System.Windows.Controls.Grid
  $c0 = New-Object System.Windows.Controls.ColumnDefinition
  $c0.Width = New-Object System.Windows.GridLength(0, "Auto")
  $c1 = New-Object System.Windows.Controls.ColumnDefinition
  $c1.Width = New-Object System.Windows.GridLength(1, "Star")
  $grid.ColumnDefinitions.Add($c0)
  $grid.ColumnDefinitions.Add($c1)

  $senderName = [string]$m.sender
  if (-not $senderName) { $senderName = "未知玩家" }

  $mono = New-Object System.Windows.Controls.Border
  $mono.Width = 22; $mono.Height = 22
  $mono.CornerRadius = New-Object System.Windows.CornerRadius(11)
  $mono.Background = ConvertTo-Brush $accent "#5FA08B"
  $mono.VerticalAlignment = "Top"
  $mono.Margin = New-Object System.Windows.Thickness(0, 1, 9, 0)
  $ml = New-Object System.Windows.Controls.TextBlock
  $ml.Text = $senderName.Substring(0, 1)
  $ml.FontSize = 12
  $ml.FontWeight = "SemiBold"
  $ml.Foreground = ConvertTo-Brush "#131920" "#131920"
  $ml.HorizontalAlignment = "Center"
  $ml.VerticalAlignment = "Center"
  $mono.Child = $ml

  $stack = New-Object System.Windows.Controls.StackPanel
  $meta = New-Object System.Windows.Controls.StackPanel
  $meta.Orientation = "Horizontal"

  $sender = New-Object System.Windows.Controls.TextBlock
  $sender.FontWeight = "SemiBold"; $sender.FontSize = 11.5
  $sender.Foreground = ConvertTo-Brush $accent "#5FA08B"
  $hero = New-Object System.Windows.Controls.TextBlock
  $hero.FontSize = 10.5; $hero.Margin = New-Object System.Windows.Thickness(6, 0, 0, 0)
  $hero.Foreground = ConvertTo-Brush $script:T.Ink3 "#6E7785"
  $meta.Children.Add($sender) | Out-Null
  $meta.Children.Add($hero) | Out-Null

  $orig = New-Object System.Windows.Controls.TextBlock
  $orig.FontSize = 11.5; $orig.TextWrapping = "Wrap"
  $orig.Margin = New-Object System.Windows.Thickness(0, 3, 0, 0)
  $orig.Foreground = ConvertTo-Brush $script:T.Ink3 "#6E7785"

  $trans = New-Object System.Windows.Controls.TextBlock
  $trans.FontSize = 13; $trans.TextWrapping = "Wrap"
  $trans.Margin = New-Object System.Windows.Thickness(0, 2, 0, 0)
  $trans.Foreground = ConvertTo-Brush $script:T.Ink "#E9E3D5"

  $stack.Children.Add($meta) | Out-Null
  $stack.Children.Add($orig) | Out-Null
  $stack.Children.Add($trans) | Out-Null

  [System.Windows.Controls.Grid]::SetColumn($mono, 0)
  [System.Windows.Controls.Grid]::SetColumn($stack, 1)
  $grid.Children.Add($mono) | Out-Null
  $grid.Children.Add($stack) | Out-Null
  $wrap.Child = $grid
  $wrap | Add-Member -NotePropertyName Parts -NotePropertyValue @{
    sender = $sender; hero = $hero; orig = $orig; trans = $trans
  } -Force
  return $wrap
}

function Show-Message($m) {
  $node = $script:Nodes[[string]$m.seq]
  if (-not $node) {
    $node = New-MessageNode $m
    $script:Nodes[[string]$m.seq] = $node
    if ($script:EmptyText -and $script:EmptyText.Parent) {
      $script:MsgList.Children.Remove($script:EmptyText) | Out-Null
    }
    $script:MsgList.Children.Add($node) | Out-Null
  }
  $p = $node.Parts
  $p.sender.Text = if ($m.sender) { [string]$m.sender } else { "未知玩家" }
  $p.hero.Text = [string]$m.hero
  $p.orig.Text = [string]$m.text
  # displayMode 与游戏内 /tr 一致:translation_only 时不重复显示原文
  if ((Get-UiValue "displayMode") -eq "translation_only") { $p.orig.Text = "" }
  if ($m.translation) {
    $p.trans.Text = [string]$m.translation
    $p.trans.Foreground = ConvertTo-Brush $script:T.Ink "#E9E3D5"
  } elseif ($m.pending) {
    $p.trans.Text = "翻译中…"
    $p.trans.Foreground = ConvertTo-Brush $script:T.Ink3 "#6E7785"
  } elseif ($m.error) {
    $p.trans.Text = "翻译失败:" + [string]$m.error
    $p.trans.Foreground = ConvertTo-Brush $script:T.Danger "#CB6A5F"
  } else {
    $p.trans.Text = ""
  }
}

function Remove-OldNodes() {
  if ($script:Nodes.Count -le 200) { return }
  $keys = $script:Nodes.Keys | Sort-Object { [int]$_ }
  $drop = $keys | Select-Object -First ($keys.Count - 200)
  foreach ($k in $drop) {
    $n = $script:Nodes[$k]
    if ($n.Parent) { $script:MsgList.Children.Remove($n) | Out-Null }
    $script:Nodes.Remove($k)
  }
}

# ============================================================ subtitle layer
# Speaker identity is carried by a monogram medallion rather than an avatar
# (Panorama never exposed avatars). A name always maps to the same swatch from a
# small curated palette, so "who is talking" reads at a glance - and unlike a
# hash-generated hue, the palette stays legible on video.
$script:SpeakerPalette = @(
  "#7FB2E5", "#E8B27F", "#93D3A4", "#D6A3D6",
  "#E3CE86", "#87CFCF", "#BFA6E6", "#E3A0AC"
)
function Get-SpeakerBrush([string]$name) {
  $h = 0
  for ($i = 0; $i -lt $name.Length; $i++) { $h = ($h * 31 + [int][char]$name[$i]) % 100003 }
  return ConvertTo-Brush $script:SpeakerPalette[$h % $script:SpeakerPalette.Count] "#7FB2E5"
}

function New-SubtitleChip($m) {
  $s = $script:Ov.subtitle
  $outer = New-Object System.Windows.Controls.Border
  $outer.Background = New-PanelBrush ([string]$s.bgColor) ([double]$s.bgOpacity)
  $outer.CornerRadius = New-Object System.Windows.CornerRadius([double]$s.radius)
  $outer.Padding = New-Object System.Windows.Thickness(7, 5, 9, 5)
  $outer.Margin = New-Object System.Windows.Thickness(0, 0, 0, [double]$s.gap)
  $outer.Opacity = 0

  $grid = New-Object System.Windows.Controls.Grid
  $c0 = New-Object System.Windows.Controls.ColumnDefinition
  $c0.Width = New-Object System.Windows.GridLength(0, "Auto")
  $c1 = New-Object System.Windows.Controls.ColumnDefinition
  $c1.Width = New-Object System.Windows.GridLength(1, "Star")
  $grid.ColumnDefinitions.Add($c0)
  $grid.ColumnDefinitions.Add($c1)

  $name = [string]$m.sender
  if (-not $name) { $name = "?" }

  $stack = New-Object System.Windows.Controls.StackPanel
  $nameTb = New-Object System.Windows.Controls.TextBlock
  $nameTb.Text = $name
  $nameTb.FontSize = [double]$s.nameSize
  $nameTb.Foreground = ConvertTo-Brush ([string]$s.nameColor) "#A8B0BE"
  $origTb = New-Object System.Windows.Controls.TextBlock
  $origTb.Text = [string]$m.text
  $origTb.FontSize = [double]$s.origSize
  $origTb.TextWrapping = "Wrap"
  $origTb.Margin = New-Object System.Windows.Thickness(0, 1, 0, 0)
  $origTb.Foreground = ConvertTo-Brush ([string]$s.origColor) "#8A93A3"
  $transTb = New-Object System.Windows.Controls.TextBlock
  $transTb.FontSize = [double]$s.fontSize
  $transTb.TextWrapping = "Wrap"
  $transTb.Margin = New-Object System.Windows.Thickness(0, 2, 0, 0)
  $transTb.Foreground = ConvertTo-Brush ([string]$s.textColor) "#F2F4F8"

  if ([bool]$s.showSender) { $stack.Children.Add($nameTb) | Out-Null }
  if ([bool]$s.showOriginal) { $stack.Children.Add($origTb) | Out-Null }
  $stack.Children.Add($transTb) | Out-Null

  if ([bool]$s.showSender) {
    $mono = New-Object System.Windows.Controls.Border
    $mono.Width = 22; $mono.Height = 22
    $mono.CornerRadius = New-Object System.Windows.CornerRadius(11)
    $mono.Background = Get-SpeakerBrush $name
    $mono.VerticalAlignment = "Top"
    $mono.Margin = New-Object System.Windows.Thickness(0, 1, 8, 0)
    $ml = New-Object System.Windows.Controls.TextBlock
    $ml.Text = $name.Substring(0, 1)
    $ml.FontSize = 12
    $ml.FontWeight = "SemiBold"
    $ml.Foreground = ConvertTo-Brush "#12151B" "#12151B"
    $ml.HorizontalAlignment = "Center"
    $ml.VerticalAlignment = "Center"
    $mono.Child = $ml
    [System.Windows.Controls.Grid]::SetColumn($mono, 0)
    $grid.Children.Add($mono) | Out-Null
  }

  [System.Windows.Controls.Grid]::SetColumn($stack, 1)
  $grid.Children.Add($stack) | Out-Null
  $outer.Child = $grid
  $outer | Add-Member -NotePropertyName Parts -NotePropertyValue @{
    name = $nameTb; orig = $origTb; trans = $transTb
  } -Force
  return $outer
}

function Add-Subtitle($m) {
  # 面板模式下不建字幕节点(否则白建一堆永远不会显示的控件)
  if (-not $script:DmWindow.IsVisible) { return }
  $s = $script:Ov.subtitle
  $shown = [string]$m.translation
  if (-not $shown) { $shown = [string]$m.text }
  if (-not $shown) { return }

  $key = [string]$m.seq
  $node = $script:SubNodes[$key]
  if ($node) {
    # 译文后到:原地补上,不新增一条(否则会闪两条)
    $node.Parts.trans.Text = $shown
    $script:DmList.Children.Remove($node) | Out-Null
    $script:DmList.Children.Add($node) | Out-Null
    return
  }
  # 轮询每次都会回看最近 40 条(为了补后到的译文),已超时消失的那条不能复活
  if ($script:SubSeen.ContainsKey($key)) { return }
  $script:SubSeen[$key] = $true
  if ($script:SubSeen.Count -gt 400) { $script:SubSeen.Clear() }

  $node = New-SubtitleChip $m
  $node.Parts.trans.Text = $shown
  $script:SubNodes[$key] = $node
  $script:DmList.Children.Add($node) | Out-Null
  $script:DmItems += ,@{ node = $node; seq = $key; born = [DateTime]::Now; life = [int]$s.lifeMs }

  while ($script:DmItems.Count -gt [int]$s.maxVisible) {
    $old = $script:DmItems[0]
    $script:DmList.Children.Remove($old.node) | Out-Null
    $script:SubNodes.Remove([string]$old.seq)
    $script:DmItems = @($script:DmItems | Select-Object -Skip 1)
  }
}

$script:EaseTimer.Add_Tick({
  if (-not $script:DmWindow.IsVisible) { return }
  $now = [DateTime]::Now
  $fade = [double]$script:Ov.subtitle.fadeMs
  if ($fade -lt 1) { $fade = 1 }
  # persist: 到时间也不淡出, 只由 Add-Subtitle 的"超过 maxVisible 就挤掉最旧的"来淘汰
  $persist = [bool]$script:Ov.subtitle.persist
  $keep = @()
  foreach ($it in $script:DmItems) {
    $age = ($now - $it.born).TotalMilliseconds
    if ($age -lt $fade) { $it.node.Opacity = $age / $fade }
    elseif ($persist) { $it.node.Opacity = 1 }
    elseif ($age -le $it.life) { $it.node.Opacity = 1 }
    else {
      $f = 1 - (($age - $it.life) / $fade)
      if ($f -le 0) {
        $script:DmList.Children.Remove($it.node) | Out-Null
        $script:SubNodes.Remove([string]$it.seq) | Out-Null
        continue
      }
      $it.node.Opacity = $f
    }
    $keep += ,$it
  }
  $script:DmItems = $keep
})

function Apply-SubtitleLayout() {
  $s = $script:Ov.subtitle
  $wa = [System.Windows.SystemParameters]::WorkArea
  $w = [Math]::Min([Math]::Max(220, [double]$s.width), $wa.Width)
  $h = [Math]::Min(600, [Math]::Max(100, [int]$s.maxVisible * [double]$s.fontSize * 3.4))
  $script:DmWindow.Width = $w
  $script:DmWindow.Height = $h
  # 编辑中不要打断用户正拖着的窗口
  if ($script:SubEditMode) { return }
  $x = $wa.Left + $wa.Width * [double]$s.xRatio
  $y = $wa.Top + $wa.Height * [double]$s.yRatio
  $script:DmWindow.Left = [Math]::Min([Math]::Max($x, $wa.Left), $wa.Right - $w)
  $script:DmWindow.Top = [Math]::Min([Math]::Max($y, $wa.Top), $wa.Bottom - $h)
}

# Click-through is what keeps the caption layer from eating game clicks, but a
# click-through window cannot be dragged - so edit mode temporarily switches the
# extended style back off.
function Set-SubtitleClickThrough([bool]$on) {
  try {
    $h = (New-Object System.Windows.Interop.WindowInteropHelper($script:DmWindow)).Handle
    if ($h -eq [IntPtr]::Zero) { return }
    $ex = [Win.Native]::GetWindowLong($h, -20)
    if ($on) { $ex = $ex -bor 0x20 }
    else { $ex = $ex -band (-bnot 0x20) }
    [Win.Native]::SetWindowLong($h, -20, $ex -bor 0x80000) | Out-Null
  } catch {}
}

function Save-SubtitlePosition() {
  $wa = [System.Windows.SystemParameters]::WorkArea
  $xr = ($script:DmWindow.Left - $wa.Left) / [Math]::Max(1.0, $wa.Width)
  $yr = ($script:DmWindow.Top - $wa.Top) / [Math]::Max(1.0, $wa.Height)
  $xr = [Math]::Round([Math]::Min(1.0, [Math]::Max(0.0, $xr)), 3)
  $yr = [Math]::Round([Math]::Min(1.0, [Math]::Max(0.0, $yr)), 3)
  try {
    $script:Ov.subtitle.xRatio = $xr
    $script:Ov.subtitle.yRatio = $yr
  } catch {}
  Save-Overlay @{ subtitle = @{ xRatio = $xr; yRatio = $yr } }
}

function Set-SubtitleEditMode([bool]$on) {
  $script:SubEditMode = $on
  $script:DmEditFrame.Visibility = if ($on) { "Visible" } else { "Collapsed" }
  Set-SubtitleClickThrough (-not $on)
  if ($on) {
    $script:DmEditHint.Text = "拖动放置 · 松手记住位置 · 点弹幕/设置退出"
  }
}

function Show-SubtitleWindow([bool]$on) {
  if ($on) {
    if (-not $script:DmWindow.IsVisible) {
      $script:DmWindow.Show()
      $script:EaseTimer.Start()
      Set-SubtitleClickThrough (-not $script:SubEditMode)
      # 字幕模式下把面板收成边缘细条:既不挡视野,又留一个能回来改设置的入口
      Collapse-Window
    }
  } else {
    $script:EaseTimer.Stop()
    if ($script:SubEditMode) { Set-SubtitleEditMode $false }
    foreach ($it in $script:DmItems) { $script:DmList.Children.Remove($it.node) | Out-Null }
    $script:DmItems = @()
    $script:SubNodes = @{}
    if ($script:DmWindow.IsVisible) { $script:DmWindow.Hide() }
  }
}

# ============================================================ status / hint
function Set-Status([bool]$online, [string]$extra) {
  $text = if ($online) { "桥在线" + $(if ($extra) { " · " + $extra } else { "" }) } else { "桥离线" }
  if ($script:LastStatus -eq $text) { return }
  $script:LastStatus = $text
  $script:StatusText.Text = $text
  $script:Dot.Fill = ConvertTo-Brush $(if ($online) { $script:T.Ok } else { $script:T.Danger }) $script:T.Ok
}

function Show-Hint([string]$text, [string]$kind) {
  $script:Hint.Text = $text
  $color = $script:T.Ink3
  if ($kind -eq "warn") { $color = $script:T.Danger } elseif ($kind -eq "ok") { $color = $script:T.Ok }
  $script:Hint.Foreground = ConvertTo-Brush $color $script:T.Ink3
}

# ============================================================ settings page
# Rows are generated from a spec instead of hand-written XAML: the option list
# mirrors the in-game /tr panel plus the new overlay-only knobs.
$script:FieldSpec = @(
  @{ k = "ui.enabled"; t = "启用翻译"; c = "bool" }
  @{ k = "provider"; t = "翻译服务"; c = "enum"; o = @(
      @("bing", "bing(免 Key)"), @("microsoft", "Microsoft/Azure Key"),
      @("openai", "OpenAI 兼容(DeepSeek 等)"), @("deepl", "DeepL"), @("google", "Google Cloud")) }
  @{ k = "apiKey"; t = "API Key(留 ******** 表示不改)"; c = "secret" }
  @{ k = "region"; t = "Azure 区域(仅 microsoft)"; c = "text" }
  @{ k = "openaiBaseUrl"; t = "OpenAI Base URL"; c = "text" }
  @{ k = "openaiModel"; t = "OpenAI 模型"; c = "text" }
  @{ k = "ui.targetLanguage"; t = "目标语言(看别人说的话)"; c = "enum"; o = @(
      @("zh-Hans", "简体中文"), @("zh-Hant", "繁體中文"), @("en", "English"),
      @("ja", "日本語"), @("ko", "한국어"), @("fr", "Français"), @("de", "Deutsch"), @("es", "Español")) }
  @{ k = "ui.displayMode"; t = "显示模式"; c = "enum"; o = @(
      @("bilingual", "双语(原文+译文)"), @("translation_only", "仅译文")) }
  @{ k = "ui.outgoing"; t = "发送模式"; c = "enum"; o = @(
      @("off", "关(发原文)"), @("translation", "仅译文"), @("bilingual", "双语")) }
  @{ k = "ui.outgoingTarget"; t = "发送目标语言"; c = "enum"; o = @(
      @("en", "English"), @("zh-Hans", "简体中文"), @("ja", "日本語"),
      @("ko", "한국어"), @("fr", "Français"), @("de", "Deutsch"), @("es", "Español")) }
  @{ k = "timeoutMs"; t = "翻译超时(ms)"; c = "int" }
  @{ k = "ui.force"; t = "强制翻译(跳过语言判断)"; c = "bool" }
  @{ k = "chatLog.enabled"; t = "聊天日志(logs/chat)"; c = "bool" }

  @{ h = "悬浮窗" }
  @{ k = "overlay.view"; t = "显示形态"; c = "enum"; o = @(
      @("panel", "面板窗口"), @("subtitle", "字幕浮层(鼠标穿透)")) }
  @{ k = "overlay.opacity"; t = "面板不透明度"; c = "range"; min = 0.2; max = 1; step = 0.05 }
  @{ k = "overlay.background"; t = "背景色(#RRGGBB)"; c = "color" }
  @{ k = "overlay.backgroundImage"; t = "背景图片(留空=纯色,预留)"; c = "file" }
  @{ k = "overlay.cornerRadius"; t = "圆角"; c = "int" }
  @{ k = "overlay.accent"; t = "主题色"; c = "color" }
  @{ k = "overlay.fontSize"; t = "面板字号"; c = "int" }
  @{ k = "overlay.autoHide"; t = "贴边自动收起"; c = "bool" }
  @{ k = "overlay.awakeMs"; t = "新消息弹出时长(ms)"; c = "int" }
  @{ k = "overlay.edge"; t = "收起贴哪条边(拖到边缘可自动改)"; c = "enum"; o = @(
      @("right", "右"), @("left", "左"), @("top", "上"), @("bottom", "下")) }

  @{ h = "字幕浮层" }
  @{ k = "overlay.subtitle.width"; t = "每条宽度(px)"; c = "int" }
  @{ k = "overlay.subtitle.persist"; t = "一直留存(不按时间消失,只保留最近 N 条)"; c = "bool" }
  @{ k = "overlay.subtitle.lifeMs"; t = "留存时间(ms,仅在上项关闭时生效)"; c = "int" }
  @{ k = "overlay.subtitle.fadeMs"; t = "淡入/淡出时长(ms)"; c = "int" }
  @{ k = "overlay.subtitle.maxVisible"; t = "同屏最多条数"; c = "int" }
  @{ k = "overlay.subtitle.gap"; t = "条间距"; c = "int" }
  @{ k = "overlay.subtitle.showSender"; t = "显示昵称与发言者色块"; c = "bool" }
  @{ k = "overlay.subtitle.showOriginal"; t = "显示原文"; c = "bool" }
  @{ k = "overlay.subtitle.fontSize"; t = "译文字号"; c = "int" }
  @{ k = "overlay.subtitle.nameSize"; t = "昵称字号"; c = "int" }
  @{ k = "overlay.subtitle.origSize"; t = "原文字号"; c = "int" }
  @{ k = "overlay.subtitle.textColor"; t = "译文颜色"; c = "color" }
  @{ k = "overlay.subtitle.nameColor"; t = "昵称颜色"; c = "color" }
  @{ k = "overlay.subtitle.origColor"; t = "原文颜色"; c = "color" }
  @{ k = "overlay.subtitle.bgColor"; t = "胶囊底色"; c = "color" }
  @{ k = "overlay.subtitle.bgOpacity"; t = "胶囊不透明度"; c = "range"; min = 0; max = 1; step = 0.05 }
  @{ k = "overlay.subtitle.radius"; t = "胶囊圆角"; c = "int" }
)

function Get-PathValue($obj, [string]$path) {
  $cur = $obj
  foreach ($seg in $path.Split(".")) {
    if ($null -eq $cur) { return $null }
    $cur = $cur.$seg
  }
  return $cur
}

function Get-UiValue([string]$name) {
  try { return Get-PathValue $script:Cfg ("ui." + $name) } catch { return $null }
}

# Section head: a brass label with the hairline running out to the edge. The
# rule is structure, not decoration - it is what separates one group of settings
# from the next in a list where every row would otherwise look identical.
function Set-RowLabel([string]$text) {
  $grid = New-Object System.Windows.Controls.Grid
  $grid.Margin = New-Object System.Windows.Thickness(0, 14, 0, 7)
  $c0 = New-Object System.Windows.Controls.ColumnDefinition
  $c0.Width = New-Object System.Windows.GridLength(0, "Auto")
  $c1 = New-Object System.Windows.Controls.ColumnDefinition
  $c1.Width = New-Object System.Windows.GridLength(1, "Star")
  $grid.ColumnDefinitions.Add($c0)
  $grid.ColumnDefinitions.Add($c1)

  $tb = New-Object System.Windows.Controls.TextBlock
  $tb.Text = $text
  $tb.Foreground = ConvertTo-Brush $script:T.Brass "#C9A44E"
  $tb.FontWeight = "SemiBold"
  $tb.FontSize = 11
  $tb.VerticalAlignment = "Center"
  [System.Windows.Controls.Grid]::SetColumn($tb, 0)

  $rule = New-Object System.Windows.Controls.Border
  $rule.Height = 1
  $rule.Background = ConvertTo-Brush $script:T.Line "#2C353F"
  $rule.VerticalAlignment = "Center"
  $rule.Margin = New-Object System.Windows.Thickness(10, 1, 0, 0)
  [System.Windows.Controls.Grid]::SetColumn($rule, 1)

  $grid.Children.Add($tb) | Out-Null
  $grid.Children.Add($rule) | Out-Null
  $script:SettingsList.Children.Add($grid) | Out-Null
}

function New-RowContainer([string]$label, $control) {
  $grid = New-Object System.Windows.Controls.Grid
  $grid.Margin = New-Object System.Windows.Thickness(0, 3, 0, 3)
  $c0 = New-Object System.Windows.Controls.ColumnDefinition
  $c0.Width = New-Object System.Windows.GridLength(1, "Star")
  $c1 = New-Object System.Windows.Controls.ColumnDefinition
  $c1.Width = New-Object System.Windows.GridLength(150, "Pixel")
  $grid.ColumnDefinitions.Add($c0)
  $grid.ColumnDefinitions.Add($c1)
  $lb = New-Object System.Windows.Controls.TextBlock
  $lb.Text = $label
  $lb.TextWrapping = "Wrap"
  $lb.FontSize = 11.5
  $lb.VerticalAlignment = "Center"
  $lb.Margin = New-Object System.Windows.Thickness(0, 0, 10, 0)
  $lb.Foreground = ConvertTo-Brush $script:T.Ink2 "#A9B1BD"
  [System.Windows.Controls.Grid]::SetColumn($lb, 0)
  $control.HorizontalAlignment = "Right"
  [System.Windows.Controls.Grid]::SetColumn($control, 1)
  $grid.Children.Add($lb) | Out-Null
  $grid.Children.Add($control) | Out-Null
  $script:SettingsList.Children.Add($grid) | Out-Null
}

function Build-SettingsUi() {
  $script:SettingsList.Children.Clear()
  $script:Ctl = @{}
  foreach ($f in $script:FieldSpec) {
    if ($f.h) { Set-RowLabel $f.h; continue }
    $val = Get-PathValue $script:Cfg $f.k
    switch ($f.c) {
      "bool" {
        $cb = New-Object System.Windows.Controls.CheckBox
        $cb.IsChecked = [bool]$val
        $cb.VerticalAlignment = "Center"
        $cb.Foreground = ConvertTo-Brush "#E8ECF3" "#E8ECF3"
        $script:Ctl[$f.k] = $cb
        New-RowContainer $f.t $cb
      }
      "enum" {
        $cb = New-Object System.Windows.Controls.ComboBox
        $cb.Width = 150
        $labels = @($f.o | ForEach-Object { $_[1] })
        $cb.ItemsSource = $labels
        $cb | Add-Member -NotePropertyName Opts -NotePropertyValue $f.o -Force
        $idx = 0
        for ($i = 0; $i -lt $f.o.Count; $i++) { if ($f.o[$i][0] -eq [string]$val) { $idx = $i } }
        $cb.SelectedIndex = $idx
        $script:Ctl[$f.k] = $cb
        New-RowContainer $f.t $cb
      }
      "int" {
        $tb = New-Object System.Windows.Controls.TextBox
        # 外观交给全局 TextBox 模板; 逐行再写一套会盖掉模板, 造成配色不一致
        $tb.Width = 84; $tb.Text = [string]$val
        $script:Ctl[$f.k] = $tb
        New-RowContainer $f.t $tb
      }
      "text" {
        $tb = New-Object System.Windows.Controls.TextBox
        $tb.Width = 150; $tb.Text = [string]$val
        $script:Ctl[$f.k] = $tb
        New-RowContainer $f.t $tb
      }
      "secret" {
        $panel = New-Object System.Windows.Controls.StackPanel
        $panel.Orientation = "Horizontal"
        $tb = New-Object System.Windows.Controls.TextBox
        $tb.Width = 118; $tb.Text = [string]$val
        $clr = New-Object System.Windows.Controls.Button
        $clr.Content = "清除"; $clr.Margin = New-Object System.Windows.Thickness(4, 0, 0, 0)
        $clr.Add_Click({
          $script:Ctl["apiKey"].Text = ""
          $script:CfgTouched["clearApiKey"] = $true
        })
        $panel.Children.Add($tb) | Out-Null
        $panel.Children.Add($clr) | Out-Null
        $script:Ctl[$f.k] = $tb
        New-RowContainer $f.t $panel
      }
      "color" {
        $panel = New-Object System.Windows.Controls.StackPanel
        $panel.Orientation = "Horizontal"
        $sw = New-Object System.Windows.Controls.Border
        $sw.Width = 18; $sw.Height = 18; $sw.CornerRadius = New-Object System.Windows.CornerRadius(3)
        $sw.BorderBrush = ConvertTo-Brush "#2A3040" "#2A3040"
        $sw.BorderThickness = New-Object System.Windows.Thickness(1)
        $sw.Background = ConvertTo-Brush ([string]$val) "#000000"
        $sw.Margin = New-Object System.Windows.Thickness(0, 0, 5, 0)
        $tb = New-Object System.Windows.Controls.TextBox
        $tb.Width = 86; $tb.Text = [string]$val
        $tb | Add-Member -NotePropertyName Swatch -NotePropertyValue $sw -Force
        $tb.Add_TextChanged({ try { $tb.Swatch.Background = ConvertTo-Brush $tb.Text "#000000" } catch {} })
        $panel.Children.Add($sw) | Out-Null
        $panel.Children.Add($tb) | Out-Null
        $script:Ctl[$f.k] = $tb
        New-RowContainer $f.t $panel
      }
      "file" {
        $panel = New-Object System.Windows.Controls.StackPanel
        $panel.Orientation = "Horizontal"
        $tb = New-Object System.Windows.Controls.TextBox
        $tb.Width = 104; $tb.Text = [string]$val
        $btn = New-Object System.Windows.Controls.Button
        $btn.Content = "浏览"; $btn.Margin = New-Object System.Windows.Thickness(4, 0, 0, 0)
        $btn.Add_Click({
          $dlg = New-Object Microsoft.Win32.OpenFileDialog
          $dlg.Filter = "图片|*.png;*.jpg;*.jpeg;*.bmp;*.gif|所有文件|*.*"
          if ($dlg.ShowDialog() -eq $true) { $script:Ctl["overlay.backgroundImage"].Text = $dlg.FileName }
        })
        $panel.Children.Add($tb) | Out-Null
        $panel.Children.Add($btn) | Out-Null
        $script:Ctl[$f.k] = $tb
        New-RowContainer $f.t $panel
      }
      "range" {
        $panel = New-Object System.Windows.Controls.StackPanel
        $panel.Orientation = "Horizontal"
        $sl = New-Object System.Windows.Controls.Slider
        $sl.Width = 110
        $sl.Minimum = [double]$f.min; $sl.Maximum = [double]$f.max
        $sl.SmallChange = [double]$f.step; $sl.LargeChange = [double]$f.step
        $sl.TickFrequency = [double]$f.step; $sl.IsSnapToTickEnabled = $true
        $v = [double]$val
        if ($v -lt $sl.Minimum) { $v = $sl.Minimum }
        if ($v -gt $sl.Maximum) { $v = $sl.Maximum }
        $sl.Value = $v
        $lb = New-Object System.Windows.Controls.TextBlock
        $lb.Text = "{0:0.##}" -f $v
        $lb.Width = 28; $lb.Margin = New-Object System.Windows.Thickness(6, 0, 0, 0)
        $lb.VerticalAlignment = "Center"
        $lb.Foreground = ConvertTo-Brush "#96A0B3" "#96A0B3"
        $sl.Add_ValueChanged({ $lb.Text = "{0:0.##}" -f $sl.Value })
        $panel.Children.Add($sl) | Out-Null
        $panel.Children.Add($lb) | Out-Null
        $script:Ctl[$f.k] = $sl
        New-RowContainer $f.t $panel
      }
    }
  }
}

function Read-SettingsPayload() {
  $ov = @{}
  $sub = @{}
  $ui = @{}
  $payload = @{}
  foreach ($f in $script:FieldSpec) {
    if ($f.h) { continue }
    $ctl = $script:Ctl[$f.k]
    if (-not $ctl) { continue }
    switch ($f.c) {
      "bool" { $v = [bool]$ctl.IsChecked }
      "enum" { $v = $ctl.Opts[$ctl.SelectedIndex][0] }
      "range" { $v = [double]$ctl.Value }
      "int" { $n = 0; if ([int]::TryParse($ctl.Text.Trim(), [ref]$n)) { $v = $n } else { continue } }
      default { $v = $ctl.Text.Trim() }
    }
    $segs = $f.k.Split(".")
    if ($segs[0] -eq "overlay") {
      if ($segs.Count -eq 3) { $sub[$segs[2]] = $v } else { $ov[$segs[1]] = $v }
    } elseif ($segs[0] -eq "ui") {
      $ui[$segs[1]] = $v
    } elseif ($segs[0] -eq "chatLog") {
      $cl = @{}
      $cl[$segs[1]] = $v
      $payload["chatLog"] = $cl
    } else {
      $payload[$segs[0]] = $v
    }
  }
  if ($script:CfgTouched["clearApiKey"] -and $script:Ctl["apiKey"].Text -eq "") {
    $payload["apiKey"] = ""
    $payload["clearApiKey"] = $true
  } elseif ($payload["apiKey"] -eq "********") {
    # keep the stored key untouched
    $payload.Remove("apiKey")
  }
  $ov["subtitle"] = $sub
  $payload["ui"] = $ui
  $payload["overlay"] = $ov
  return $payload
}

function Save-Settings() {
  try {
    # POST /api/v1/config expects {config:{...}} - a flat body is silently ignored.
    $r = Invoke-ApiPost "$Bridge/api/v1/config" @{ config = (Read-SettingsPayload) }
    if (-not $r -or -not $r.ok) { throw "save_rejected" }
    $script:SettingsHint.Foreground = ConvertTo-Brush "#4AD07A" "#4AD07A"
    $script:SettingsHint.Text = "已保存。部分设置需要重启桥后生效。"
    $script:CfgTouched = @{}
    Load-Config
    Apply-Config
  } catch {
    $script:SettingsHint.Foreground = ConvertTo-Brush "#E05A5A" "#E05A5A"
    $script:SettingsHint.Text = "保存失败:桥未响应或配置被拒绝"
  }
}

# Persist a single overlay sub-object (used by drag-snap to remember the edge).
function Save-Overlay($partial) {
  try { Invoke-ApiPost "$Bridge/api/v1/config" @{ config = @{ overlay = $partial } } | Out-Null } catch {}
}

# ============================================================ config apply
function Load-Config() {
  try {
    # GET /api/v1/config answers {ok, config:{...}} - unwrap it.
    $resp = Invoke-ApiGet "$Bridge/api/v1/config"
    if ($resp -and $resp.config) {
      $script:Cfg = $resp.config
      $script:Ov = $script:Cfg.overlay
    }
  } catch {}
  if (-not $script:Ov) {
    $script:Cfg = $null
    $script:Ov = @{
      view = "panel"; opacity = 0.85; background = "#0D0F14"; backgroundImage = ""
      cornerRadius = 10; accent = "#E0A34A"; fontSize = 12; edge = "right"
      autoHide = $true; awakeMs = 6000; enabled = $true
      subtitle = @{
        xRatio = 0.02; yRatio = 0.30; width = 380
        fontSize = 15; nameSize = 11; origSize = 11
        bgColor = "#0A0C11"; bgOpacity = 0.55; radius = 8; gap = 6
        lifeMs = 9000; fadeMs = 260; maxVisible = 6; persist = $false
        textColor = "#F2F4F8"; nameColor = "#A8B0BE"; origColor = "#8A93A3"
        showSender = $true; showOriginal = $true
      }
    }
  }
}

function Apply-Config() {
  $ov = $script:Ov
  $script:Root.Opacity = 1.0
  $bg = New-PanelBrush ([string]$ov.background) ([double]$ov.opacity)
  $img = [string]$ov.backgroundImage
  if ($img -and (Test-Path $img)) {
    try {
      $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
      $bmp.BeginInit()
      $bmp.UriSource = New-Object System.Uri($img)
      $bmp.CacheOption = "OnLoad"
      $bmp.EndInit()
      $bi = New-Object System.Windows.Media.ImageBrush
      $bi.ImageSource = $bmp
      $bi.Stretch = "UniformToFill"
      $bi.Opacity = [double]$ov.opacity
      $script:Root.Background = $bi
    } catch { $script:Root.Background = $bg }
  } else {
    $script:Root.Background = $bg
  }
  $script:Root.CornerRadius = New-Object System.Windows.CornerRadius([double]$ov.cornerRadius)
  $script:Root.BorderBrush = ConvertTo-Brush ([string]$ov.accent) "#E0A34A"
  $script:Edge = [string]$ov.edge
  $script:AutoHide = [bool]$ov.autoHide
  $script:AwakeMs = [int]$ov.awakeMs
  $script:AwakeTimer.Interval = [TimeSpan]::FromMilliseconds([Math]::Max(500, $script:AwakeMs))
  $script:PinBtn.Content = if ($script:AutoHide) { "固定" } else { "自动收起" }
  Apply-SubtitleLayout
  $on = ([string]$ov.view -eq "subtitle")
  Show-SubtitleWindow $on
}

# ============================================================ messaging
function Send-Outgoing() {
  $text = ([string]$script:Input.Text).Trim()
  if (-not $text) { Show-Hint "先输入要发的内容" "warn"; return }
  $script:SendBtn.IsEnabled = $false
  $script:SendBtn.Content = "翻译中…"
  try {
    $r = Invoke-ApiPost "$Bridge/api/v1/overlay/translate" @{ text = $text }
    if (-not $r -or -not $r.ok) { throw "translate_failed" }
    $script:OutText.Text = [string]$r.translation
    $script:OutBox.Visibility = "Visible"
    try {
      [System.Windows.Clipboard]::SetText([string]$r.translation)
      Show-Hint "已复制,回游戏 Ctrl+V" "ok"
    } catch {
      Show-Hint "复制失败,请手动选中后 Ctrl+C" "warn"
    }
  } catch {
    $script:OutBox.Visibility = "Collapsed"
    Show-Hint "翻译失败,桥未响应?" "warn"
  } finally {
    $script:SendBtn.IsEnabled = $true
    $script:SendBtn.Content = "翻译并复制"
  }
}

$script:PollTimer.Add_Tick({
  try {
    $after = [Math]::Max(0, $script:LastSeq - 40)
    $j = Invoke-ApiGet "$Bridge/api/v1/overlay/messages?after=$after"
    if (-not $j -or -not $j.ok) { throw "bad_response" }
    Set-Status $true ([string]$j.provider)
    $msgs = @($j.messages)
    if ($msgs.Count -eq 0) {
      if ($j.latest -and [int]$j.latest -gt $script:LastSeq) { $script:LastSeq = [int]$j.latest }
      return
    }
    $fresh = $false
    foreach ($m in $msgs) {
      Show-Message $m
      # 每条都交给字幕层:由它自己判断"新增 / 原地补后到的译文 / 已过期忽略"
      Add-Subtitle $m
      if ([int]$m.seq -gt $script:LastSeq) {
        $script:LastSeq = [int]$m.seq
        $fresh = $true
      }
    }
    Remove-OldNodes
    if ($fresh) {
      $script:MsgScroll.ScrollToEnd()
      if ([string]$script:Ov.view -ne "subtitle") { Wake-Window }
    }
  } catch {
    # 轮询里的异常原来会被静默吞掉(只让状态变红),排障时根本看不到原因
    try {
      $line = (Get-Date).ToString("HH:mm:ss") + " poll: " + $_.Exception.Message +
              " @line " + $_.InvocationInfo.ScriptLineNumber
      Add-Content -Path (Join-Path $env:TEMP "lct-overlay-error.log") -Value $line
    } catch {}
    Set-Status $false ""
  }
})

# ============================================================ wiring
# Drag by the header; on release snap to the nearest screen edge and remember it.
# Suppress the auto-collapse animation while dragging, otherwise the window
# would slide out from under the cursor.
$script:Header.Add_MouseLeftButtonDown({
  $script:Dragging = $true
  $script:AnimTimer.Stop()
  $script:Animating = $false
  $moved = $false
  try { $script:Window.DragMove(); $moved = $true } catch {}
  $script:Dragging = $false
  if ($moved -and $script:Ready) { Snap-ToNearestEdge }
})

$script:Root.Add_MouseEnter({ $script:MouseIn = $true; Expand-Window })
$script:Root.Add_MouseLeave({
  $script:MouseIn = $false
  if ($script:Ready -and $script:AutoHide -and -not $script:InputFocused) { Collapse-Window }
})
$script:Input.Add_GotFocus({ $script:InputFocused = $true; Expand-Window })
$script:Input.Add_LostFocus({ $script:InputFocused = $false })

# Enter sends, Shift+Enter inserts a newline.
$script:Input.Add_KeyDown({
  param($s, $e)
  if ($e.Key -ne "Return") { return }
  if (($e.KeyboardDevice.Modifiers -band [System.Windows.Input.ModifierKeys]::Shift) -ne 0) { return }
  $e.Handled = $true
  Send-Outgoing
})

$script:SendBtn.Add_Click({ Send-Outgoing })
$script:CopyBtn.Add_Click({
  try {
    [System.Windows.Clipboard]::SetText([string]$script:OutText.Text)
    Show-Hint "已复制,回游戏 Ctrl+V" "ok"
  } catch {
    Show-Hint "复制失败,请手动选中后 Ctrl+C" "warn"
  }
})
$script:CollapseBtn.Add_Click({ Collapse-Window })
$script:CloseBtn.Add_Click({ try { $script:Window.Close() } catch {} })

$script:PinBtn.Add_Click({
  $script:AutoHide = -not $script:AutoHide
  Save-Overlay @{ autoHide = $script:AutoHide }
  $script:PinBtn.Content = if ($script:AutoHide) { "固定" } else { "自动收起" }
  if ($script:AutoHide) { Collapse-Window } else { Expand-Window }
})

$script:SettingsBtn.Add_Click({
  $showSettings = ($script:SettingsPage.Visibility -ne "Visible")
  if ($showSettings) {
    Build-SettingsUi
    $script:SettingsHint.Foreground = ConvertTo-Brush "#96A0B3" "#96A0B3"
    $script:SettingsHint.Text = "改完点保存。游戏内显示相关项(如显示模式)在游戏里已失效——本版游戏移除了 HTTP,只有影响本悬浮窗与桥的项会生效。"
    $script:SettingsPage.Visibility = "Visible"
    $script:ChatPage.Visibility = "Collapsed"
  } else {
    $script:SettingsPage.Visibility = "Collapsed"
    $script:ChatPage.Visibility = "Visible"
  }
  Expand-Window
})

$script:CloseSettingsBtn.Add_Click({
  $script:SettingsPage.Visibility = "Collapsed"
  $script:ChatPage.Visibility = "Visible"
})
# Drag-to-place lives in the settings page: it flips the layer into edit mode
# (click-through temporarily off so the drag lands) and toggles back when done.
$script:AdjustSubBtn.Add_Click({
  if ($script:SubEditMode) {
    Set-SubtitleEditMode $false
    $script:AdjustSubBtn.Content = "调整字幕位置(拖动)"
    $script:SettingsHint.Text = "位置已保存。"
    return
  }
  if ([string]$script:Ov.view -ne "subtitle") {
    try {
      $script:Ov.view = "subtitle"
      Save-Overlay @{ view = "subtitle" }
    } catch {}
    Apply-Config
    Build-SettingsUi
  }
  if (-not $script:DmWindow.IsVisible) { Show-SubtitleWindow $true }
  Apply-SubtitleLayout
  Set-SubtitleEditMode $true
  $script:AdjustSubBtn.Content = "完成放置"
})

$script:SaveCfgBtn.Add_Click({ Save-Settings })
$script:ReloadCfgBtn.Add_Click({
  $script:CfgTouched = @{}
  Load-Config
  Apply-Config
  Build-SettingsUi
  $script:SettingsHint.Foreground = ConvertTo-Brush "#4AD07A" "#4AD07A"
  $script:SettingsHint.Text = "已从配置重新载入。"
})

$script:StartTimer.Add_Tick({
  $script:StartTimer.Stop()
  $script:Ready = $true
  if ($script:AutoHide -and -not $script:MouseIn -and -not $script:InputFocused) { Collapse-Window }
})

$script:Window.Add_Deactivated({
  if ($script:Ready -and $script:AutoHide -and -not $script:MouseIn -and -not $script:InputFocused -and
      $script:SettingsPage.Visibility -ne "Visible") {
    Collapse-Window
  }
})

$script:Window.Add_Closed({
  $script:PollTimer.Stop(); $script:AnimTimer.Stop(); $script:AwakeTimer.Stop()
  $script:EaseTimer.Stop(); $script:StartTimer.Stop()
  try { $script:DmWindow.Close() } catch {}
  try { $script:Mutex.ReleaseMutex() } catch {}
})

$script:Window.Add_SourceInitialized({
  $p = Get-EdgeTarget $true
  $script:Window.Left = $p.L
  $script:Window.Top = [System.Windows.SystemParameters]::WorkArea.Top + 90
})

# The caption layer must never eat game clicks - click-through by default.
$script:DmWindow.Add_SourceInitialized({
  Set-SubtitleClickThrough $true
})

# Drag-to-place: only reachable while edit mode has click-through switched off,
# otherwise the layer would swallow every click that happens to land on it.
$script:DmFrame.Add_MouseLeftButtonDown({
  if (-not $script:SubEditMode) { return }
  try { $script:DmWindow.DragMove() } catch {}
  Save-SubtitlePosition
})

$script:Window.Add_ContentRendered({
  Load-Config
  Apply-Config
  $script:EmptyText.Text = "等待游戏内聊天…`n`n需要先启动 Deadlock 并进入对局/大厅。"
  $p = Get-EdgeTarget $true
  $script:Window.Left = $p.L
  $script:Window.Top = $p.T
  $script:PollTimer.Start()
  $script:StartTimer.Start()
})

[void]$script:Window.ShowDialog()
