# submit-thunder-task.ps1
# Submit a Xunlei (Thunder) download task while showing NO Xunlei UI at all.
#
# Flow:
#   1. Hide the Xunlei MAIN window if one appears.
#   2. Wait for the "New Task" dialog.
#   3. Make it effectively invisible (layered alpha = 1; alpha 0 would be
#      click-through, alpha 1 is invisible to the eye but still hit-testable).
#   4. Keep it topmost and FORCE-ACTIVATE it. This step is mandatory: the dialog
#      is a CEF window and silently ignores clicks while it is not the active
#      window. Without activation the click closes the dialog but creates no task.
#   5. Click the confirm button with real mouse input (posted WM_LBUTTONDOWN is
#      ignored by CEF). Button position is derived from the dialog size by ratio,
#      which is calibrated and DPI-independent.
#   6. Restore the user's cursor and confirm the dialog went away.
#
# Exit codes:
#   0 = dialog found, clicked, dialog closed
#   4 = no dialog appeared within the timeout
#   5 = clicked but the dialog is still open
#
# IMPORTANT: this file is intentionally PURE ASCII. Chinese window titles are
#   built from code points, because Windows PowerShell 5.1 decodes a
#   UTF-8-without-BOM file as ANSI and would fail to parse non-ASCII bytes.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File submit-thunder-task.ps1 [-Seconds 15]

param(
  [int]$Seconds = 15,
  [int]$PollMs = 200
)

$ErrorActionPreference = 'SilentlyContinue'

if (-not ('ThunderTask' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class ThunderTask
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder s, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint key, byte alpha, uint flags);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

    public class Info
    {
        public IntPtr Hwnd;
        public string Title = "";
        public string Cls = "";
        public int Left, Top, Width, Height;
        public uint Pid;
    }

    public static List<Info> List()
    {
        List<Info> result = new List<Info>();
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            StringBuilder t = new StringBuilder(512);
            GetWindowTextW(h, t, t.Capacity);
            StringBuilder c = new StringBuilder(256);
            GetClassNameW(h, c, c.Capacity);
            RECT r;
            GetWindowRect(h, out r);
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            Info i = new Info();
            i.Hwnd = h;
            i.Title = t.ToString();
            i.Cls = c.ToString();
            i.Left = r.Left; i.Top = r.Top;
            i.Width = r.Right - r.Left; i.Height = r.Bottom - r.Top;
            i.Pid = pid;
            result.Add(i);
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@
}

[void][ThunderTask]::SetProcessDPIAware()

# Window titles from code points so this file stays pure ASCII.
$MAIN_TITLE   = [string]([char]0x8FC5) + [string]([char]0x96F7)
$DIALOG_TITLE = [string]([char]0x65B0) + [string]([char]0x5EFA) + [string]([char]0x4EFB) + [string]([char]0x52A1)

function Get-ThunderPids {
  $p = Get-Process -Name 'thunder' -ErrorAction SilentlyContinue
  if (-not $p) { return @() }
  return @($p | Select-Object -ExpandProperty Id)
}

function Find-Dialog {
  $pids = Get-ThunderPids
  foreach ($w in [ThunderTask]::List()) {
    if ($pids -notcontains [int]$w.Pid) { continue }
    if ($w.Title -eq $DIALOG_TITLE) { return $w }
  }
  return $null
}

function Test-IsMainWindow($w) {
  if ($w.Cls -ne 'Chrome_WidgetWin_0') { return $false }
  if ($w.Title -eq $DIALOG_TITLE) { return $false }
  if ($w.Title -eq $MAIN_TITLE) { return $true }
  if ($w.Title.StartsWith($MAIN_TITLE) -and $w.Width -ge 900) { return $true }
  return ($w.Width -ge 900 -and $w.Height -ge 500)
}

function Hide-MainWindows {
  $n = 0
  $pids = Get-ThunderPids
  foreach ($w in [ThunderTask]::List()) {
    if ($pids -notcontains [int]$w.Pid) { continue }
    if (-not (Test-IsMainWindow $w)) { continue }
    [void][ThunderTask]::ShowWindow($w.Hwnd, 0)
    $n++
  }
  return $n
}

# Make the dialog invisible without making it click-through, and keep it on top.
function Set-DialogTransparent($hWnd) {
  $ex = [ThunderTask]::GetWindowLong($hWnd, -20)
  [void][ThunderTask]::SetWindowLong($hWnd, -20, ($ex -bor 0x80000))     # WS_EX_LAYERED
  [void][ThunderTask]::SetLayeredWindowAttributes($hWnd, 0, 1, 0x2)      # alpha = 1
  [void][ThunderTask]::SetWindowPos($hWnd, [IntPtr](-1), 0, 0, 0, 0,
    0x0001 -bor 0x0002)                                                   # TOPMOST|NOSIZE
}

# CEF ignores mouse input while the window is not active, so this is not optional.
function Set-DialogActive($hWnd) {
  [void][ThunderTask]::ShowWindow($hWnd, 5)          # SW_SHOW (no-op if already shown)
  [void][ThunderTask]::BringWindowToTop($hWnd)
  [void][ThunderTask]::SetForegroundWindow($hWnd)
  [void][ThunderTask]::SetActiveWindow($hWnd)
  Start-Sleep -Milliseconds 250
  return ([ThunderTask]::GetForegroundWindow() -eq $hWnd)
}

function Invoke-Click([int]$x, [int]$y) {
  $old = New-Object ThunderTask+POINT
  [void][ThunderTask]::GetCursorPos([ref]$old)
  [void][ThunderTask]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 220
  [ThunderTask]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # LEFTDOWN
  Start-Sleep -Milliseconds 80
  [ThunderTask]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # LEFTUP
  Start-Sleep -Milliseconds 300
  [void][ThunderTask]::SetCursorPos($old.X, $old.Y)
}

# Confirm button centre as a fraction of the dialog box.
# Calibrated on this machine against a 1020x594 (physical) dialog at 150% DPI,
# where the button spans roughly x 754..985, y 483..555.
$BTN_X_RATIO = 0.853
$BTN_Y_RATIO = 0.874

# ---- main flow ----
[void](Hide-MainWindows)

$deadline = (Get-Date).AddSeconds($Seconds)
$dlg = $null
while ((Get-Date) -lt $deadline) {
  $dlg = Find-Dialog
  if ($dlg -ne $null) { break }
  Start-Sleep -Milliseconds $PollMs
}

if ($dlg -eq $null) {
  [void](Hide-MainWindows)
  Write-Output "no dialog appeared"
  exit 4
}

Write-Output ("dialog {0} {1}x{2} at ({3},{4})" -f $dlg.Hwnd, $dlg.Width, $dlg.Height, $dlg.Left, $dlg.Top)

# Let the dialog finish its open animation before measuring/clicking.
Start-Sleep -Milliseconds 700
$dlg = Find-Dialog
if ($dlg -eq $null) {
  [void](Hide-MainWindows)
  Write-Output "dialog closed by itself"
  exit 0
}

Set-DialogTransparent $dlg.Hwnd
$active = Set-DialogActive $dlg.Hwnd
Write-Output ("activated={0} size={1}x{2}" -f $active, $dlg.Width, $dlg.Height)

$bx = $dlg.Left + [int]($dlg.Width * $BTN_X_RATIO)
$by = $dlg.Top + [int]($dlg.Height * $BTN_Y_RATIO)
Write-Output ("click at {0},{1}" -f $bx, $by)
Invoke-Click $bx $by

$waitUntil = (Get-Date).AddSeconds(4)
while ((Get-Date) -lt $waitUntil) {
  if (-not [ThunderTask]::IsWindow($dlg.Hwnd)) { break }
  Start-Sleep -Milliseconds 250
}

$closed = -not [ThunderTask]::IsWindow($dlg.Hwnd)
if (-not $closed) {
  # Second attempt: re-activate (focus may have drifted) and click again.
  Write-Output "still open, retrying"
  [void](Set-DialogActive $dlg.Hwnd)
  Invoke-Click $bx $by
  Start-Sleep -Seconds 3
  $closed = -not [ThunderTask]::IsWindow($dlg.Hwnd)
}

# Starting a task often resurrects the main window: keep it hidden.
Start-Sleep -Milliseconds 500
[void](Hide-MainWindows)

if ($closed) {
  Write-Output "submitted"
  exit 0
}
Write-Output "clicked but dialog persists"
exit 5
