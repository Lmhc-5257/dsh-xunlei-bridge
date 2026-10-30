# hide-thunder-main.ps1
# Hide the Xunlei (Thunder) MAIN window while leaving the "New Task" dialog visible.
#
# Why a window script instead of Xunlei's own setting:
#   Thunder's TaskDefaultSettings.NewTaskDlgWithoutMainWnd is not reliably re-read by a
#   running instance, and the key may change between versions. Acting on the window
#   directly is deterministic.
#
# IMPORTANT: this file is intentionally PURE ASCII. Chinese window titles are built from
#   code points, and comments are English, because Windows PowerShell 5.1 decodes a
#   UTF-8-without-BOM file as ANSI and would choke on non-ASCII bytes.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File hide-thunder-main.ps1 [-Seconds 10] [-PollMs 300]
#   powershell ... -File hide-thunder-main.ps1 -Query
#
# Exit codes:
#   -Query : 0 = main window currently visible, 3 = not visible (or Thunder not running)
#   normal : 0 = hid at least one window, 1 = nothing to hide

param(
  [int]$Seconds = 10,
  [int]$PollMs = 300,
  [switch]$Query
)

$ErrorActionPreference = 'SilentlyContinue'

if (-not ('ThunderWin' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class ThunderWin
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder s, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public class Info
    {
        public IntPtr Hwnd;
        public string Title = "";
        public string Cls = "";
        public int Width;
        public int Height;
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
            i.Width = r.Right - r.Left;
            i.Height = r.Bottom - r.Top;
            i.Pid = pid;
            result.Add(i);
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@
}

# Window titles built from code points so this file stays pure ASCII.
# 0x8FC5 0x96F7 = Xunlei main window title
# 0x65B0 0x5EFA 0x4EFB 0x52A1 = "New Task" dialog title
$MAIN_TITLE = [string]([char]0x8FC5) + [string]([char]0x96F7)
$DIALOG_TITLE = [string]([char]0x65B0) + [string]([char]0x5EFA) +
                [string]([char]0x4EFB) + [string]([char]0x52A1)

# Main-window test, in order of confidence:
#   1) title is exactly the main title (measured 1082x722 on this machine)
#   2) title starts with it and the window is wide (covers a title with a version suffix)
#   3) large CEF window that is not the task dialog (fallback)
# Explicitly never matches the "New Task" dialog (680 wide, or 680x683 expanded).
function Test-IsMainWindow($w) {
  if ($w.Cls -ne 'Chrome_WidgetWin_0') { return $false }
  if ($w.Title -eq $DIALOG_TITLE) { return $false }
  if ($w.Title -eq $MAIN_TITLE) { return $true }
  if ($w.Title.StartsWith($MAIN_TITLE) -and $w.Width -ge 900) { return $true }
  return ($w.Width -ge 900 -and $w.Height -ge 500)
}

$thunderPids = @()

# ---- Query mode: report only, change nothing ----
if ($Query) {
  $procs = Get-Process -Name 'thunder' -ErrorAction SilentlyContinue
  if (-not $procs) { exit 3 }
  $thunderPids = @($procs | Select-Object -ExpandProperty Id)
  foreach ($w in [ThunderWin]::List()) {
    if ($thunderPids -notcontains [int]$w.Pid) { continue }
    if (Test-IsMainWindow $w) { exit 0 }
  }
  exit 3
}

$deadline = (Get-Date).AddSeconds($Seconds)
$hidden = 0

while ((Get-Date) -lt $deadline) {
  $procs = Get-Process -Name 'thunder' -ErrorAction SilentlyContinue
  if ($procs) { $thunderPids = @($procs | Select-Object -ExpandProperty Id) }

  foreach ($w in [ThunderWin]::List()) {
    if ($thunderPids -notcontains [int]$w.Pid) { continue }
    if (-not (Test-IsMainWindow $w)) { continue }
    # SW_HIDE = 0. Hidden, not closed: the user can restore it from the tray.
    [void][ThunderWin]::ShowWindow($w.Hwnd, 0)
    $hidden++
    Write-Output ("hidden hwnd={0} size={1}x{2} title={3}" -f $w.Hwnd, $w.Width, $w.Height, $w.Title)
  }

  if ($hidden -gt 0) {
    # Keep watching briefly: Thunder sometimes brings the main window back.
    for ($i = 0; $i -lt 6; $i++) {
      Start-Sleep -Milliseconds 400
      foreach ($w in [ThunderWin]::List()) {
        if ($thunderPids -notcontains [int]$w.Pid) { continue }
        if (-not (Test-IsMainWindow $w)) { continue }
        [void][ThunderWin]::ShowWindow($w.Hwnd, 0)
        $hidden++
      }
    }
    break
  }

  Start-Sleep -Milliseconds $PollMs
}

if ($hidden -gt 0) { exit 0 } else { exit 1 }
