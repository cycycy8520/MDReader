# MDNaonao window screenshot helper.
#
# WHY THIS EXISTS: a DPI-unaware process that calls CopyFromScreen on a
# per-monitor-DPI-aware window captures only the top-left 1/scale of it, with no
# error and no visual hint that anything is missing. On a 150% display that means
# the right third and bottom third of the window are silently absent from the
# image. Diagnosing UI from such a capture leads straight to phantom bugs
# ("content is clipped on the right!") that do not exist in the product.
#
# Windows PowerShell 5.1 is DPI-UNAWARE by default, so this script MUST opt in
# before taking any measurement. Verified 2026-08-18: without the opt-in
# GetWindowRect reported 1215x809 for a window that is really 1822x1213.
#
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads scripts as ANSI, and
# non-ASCII comments can corrupt the param() block into a parse error.
#
# Usage:
#   powershell -File scripts/shot.ps1 -Out shot.png
#   powershell -File scripts/shot.ps1 -Out shot.png -Width 1400 -Height 900

param(
  [string]$ProcessName = "mdnaonao",
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Width = 0,
  [int]$Height = 0,
  [int]$SettleMs = 900
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MdnShot {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

# SetForegroundWindow alone loses to Windows' foreground lock when the caller is not
# the active app: the target stays BEHIND whatever is on top, and CopyFromScreen then
# captures that other window instead — a screenshot of the wrong program, with no error.
# Forcing TOPMOST and dropping it again reliably raises it.
function Raise-Window([IntPtr]$hwnd) {
  $HWND_TOPMOST = [IntPtr](-1)
  $HWND_NOTOPMOST = [IntPtr](-2)
  $SWP_NOMOVE_NOSIZE = 0x0001 -bor 0x0002   # SWP_NOSIZE | SWP_NOMOVE
  [void][MdnShot]::SetWindowPos($hwnd, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_NOMOVE_NOSIZE)
  Start-Sleep -Milliseconds 150
  [void][MdnShot]::SetWindowPos($hwnd, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP_NOMOVE_NOSIZE)
}

# -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2. Must run before any window query.
if (-not [MdnShot]::SetProcessDpiAwarenessContext([IntPtr](-4))) {
  Write-Warning "SetProcessDpiAwarenessContext failed; capture may be cropped on a scaled display."
}

$proc = Get-Process -Name $ProcessName -ErrorAction Stop |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($null -eq $proc) { throw "no visible window for process '$ProcessName'" }
$h = $proc.MainWindowHandle

[void][MdnShot]::ShowWindow($h, 9)   # SW_RESTORE
if ($Width -gt 0 -and $Height -gt 0) {
  # Sizes are PHYSICAL pixels now that this process is DPI aware.
  [void][MdnShot]::MoveWindow($h, 0, 0, $Width, $Height, $true)
  Start-Sleep -Milliseconds 1500     # let the WebView re-layout before capturing
}
Raise-Window $h
[void][MdnShot]::SetForegroundWindow($h)
Start-Sleep -Milliseconds $SettleMs

$r = New-Object MdnShot+RECT
[void][MdnShot]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top

$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved $Out ($w x $ht physical px)"
