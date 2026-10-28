# dock-helper.ps1 - Win32 window placement and page cropping for dsh-edge-sidebar.
#
# The DSH host is a Node/Electron process without Win32 access from JS, so window
# placement lives here, in one place, behind a tiny JSON protocol:
#
#   stdio mode   powershell -File dock-helper.ps1 -Op stdio
#                reads one JSON object per line, writes one JSON reply per line
#   one-shot     powershell -File dock-helper.ps1 -Op place -Hwnd 123 -X 0 -Y 0 -W 400 -H 700
#
# Operations:
#   find   {pid}                     -> {hwnd}
#   place  {hwnd,x,y,w,h,owner}      -> owned, tool-window, borderless placement
#   hide   {hwnd}                    -> SW_HIDE
#   show   {hwnd}                    -> SW_SHOWNOACTIVATE
#   close  {hwnd}                    -> PostMessage WM_CLOSE
#   active {hwnd}                    -> {active:true|false}  (foreground check)
param(
  [string]$Op = 'noop',
  [long]$Hwnd = 0,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 0,
  [int]$H = 0,
  [long]$Owner = 0,
  [int]$ProcessId = 0,
  [string]$Profile = '',
  [string]$Title = ''
)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DpiContext {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static void MakePhysical() {
    // The plugin reports CSS pixels; the region rectangle is converted with the
    // window's devicePixelRatio before it gets here.
    // gets virtualized coordinates from GetWindowRect/SetWindowPos, which is exactly how
    // a docked window lands at the wrong place on a scaled display.
    try { if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return; } catch {}
    try { SetProcessDPIAware(); } catch {}
  }
}
"@
[DpiContext]::MakePhysical()
try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
} catch { /* UIA is a robustness bonus; metrics fallback stays */ }
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DockNative {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h, IntPtr rgn);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr rgn, out RECT box);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public struct RECT { public int L, T, R, B; }
  public struct POINT { public int X, Y; }
}
"@
# Native follower: a background thread inside this long-lived helper process that keeps
# the Edge window glued to the DSH sidebar body while the DSH window is moved. It works at
# the OS level (ClientToScreen + SetWindowPos), so it does not depend on renderer timers or
# WebSocket round-trips and stays tight during a window drag.
Add-Type @"
using System;
using System.Threading;
using System.Runtime.InteropServices;
public class FollowNative {
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public struct POINT { public int X, Y; }
  const uint NOZORDER = 0x0004, NOACTIVATE = 0x0010, SHOWWINDOW = 0x0040;
  static Thread thread;
  static volatile bool run;
  static IntPtr dsh = IntPtr.Zero, edge = IntPtr.Zero;
  static int offsetX, offsetY, width, height;
  static long lastX = long.MinValue, lastY = long.MinValue;
  static int lastW = -1, lastH = -1;

  public static void Start(IntPtr dshWindow, IntPtr edgeWindow, int x, int y, int w, int h) {
    Stop();
    dsh = dshWindow; edge = edgeWindow; offsetX = x; offsetY = y; width = w; height = h;
    lastX = long.MinValue; lastY = long.MinValue; lastW = -1; lastH = -1;
    run = true;
    thread = new Thread(Loop) { IsBackground = true };
    thread.Start();
  }

  public static bool IsRunning() { return run && thread != null; }

  // Update the geometry without tearing the native thread down: resizing the pane sends
  // many small updates and a thread restart per message would stutter.
  public static void Update(int x, int y, int w, int h) {
    offsetX = x; offsetY = y; width = w; height = h;
    lastX = long.MinValue; lastY = long.MinValue; lastW = -1; lastH = -1;
  }

  public static void Stop() {
    run = false;
    Thread t = thread;
    thread = null;
    if (t != null) { try { t.Join(300); } catch {} }
  }

  static void Loop() {
    // DPI awareness is PER THREAD. The main thread's context does not apply here, and an
    // unaware follower thread would virtualize ClientToScreen/SetWindowPos by 1.25 on a
    // scaled display (measured: a 650 px window became 813 px).
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch {}
    while (run) {
      try {
        if (!IsWindow(dsh) || !IsWindow(edge)) { run = false; break; }
        if (IsIconic(dsh)) {
          ShowWindow(edge, 0);
        } else {
          POINT p = new POINT();
          if (ClientToScreen(dsh, ref p)) {
            long x = p.X + offsetX;
            long y = p.Y + offsetY;
            if (x != lastX || y != lastY || width != lastW || height != lastH) {
              SetWindowPos(edge, IntPtr.Zero, (int)x, (int)y, width, height, NOACTIVATE | NOZORDER | SHOWWINDOW);
              lastX = x; lastY = y; lastW = width; lastH = height;
            }
          }
        }
      } catch {}
      Thread.Sleep(8);
    }
  }
}
"@

$GWL_STYLE = -16
$WS_CHILD = 0x40000000
$WS_POPUP = 0x80000000
$GWL_EXSTYLE = -20
$GWL_HWNDPARENT = -8
$WS_EX_TOOLWINDOW = 0x00000080
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$SWP_NOACTIVATE = 0x0010
$SWP_FRAMECHANGED = 0x0020
$SWP_SHOWWINDOW = 0x0040

function Find-MainWindow([int]$TargetProcessId) {
  # A frameless Edge `--app` window reports its HWND through .NET's MainWindowHandle;
  # no EnumWindows bookkeeping, and no confusion with PowerShell's read-only $PID.
  try {
    $process = [System.Diagnostics.Process]::GetProcessById($TargetProcessId)
    $process.Refresh()
    return $process.MainWindowHandle
  } catch { return [IntPtr]::Zero }
}

function Invoke-Op($request) {
  switch ($request.op) {
    'find' {
      $hwnd = Find-MainWindow ([int]$request.pid)
      return @{ ok = ($hwnd -ne [IntPtr]::Zero); hwnd = $hwnd.ToInt64() }
    }
    'find-profile' {
      # A launched Edge may fork: the owning window is not necessarily the spawned
      # process, and a page can spawn auxiliary Chrome windows (translation, tab search).
      # The caller passes the page TITLE and/or the CDP window bounds of the page, and
      # this op picks the browser window that matches; area is only the fallback.
      $profile = [string]$request.profile
      $wantTitle = [string]$request.title
      $wantW = [int]$request.rw
      $wantX = [int]$request.rx
      $wantY = [int]$request.ry
      $wantH = [int]$request.rh
      $tolerance = if ($request.tolerance) { [int]$request.tolerance } else { 80 }
      # One process-table snapshot instead of a Get-CimInstance per window: the per-window
      # call made this op take minutes on a desktop with many windows.
      $script:processCommands = @{}
      try {
        foreach ($proc in Get-CimInstance Win32_Process -ErrorAction Stop) {
          $script:processCommands[[int]$proc.ProcessId] = $proc.CommandLine
        }
      } catch {}
      $script:bestScore = -1
      $script:bestInfo = $null
      $cb = [DockNative+EnumProc]{
        param($h, $p)
        $text = New-Object System.Text.StringBuilder 512
        [void][DockNative]::GetWindowTextW($h, $text, 512)
        # Only the real Chromium top-level window is a browser surface. msedge also owns
        # a "GDI+ Hook Window Class" window that mirrors the browser's bounds — a rect
        # match alone would happily adopt that phantom.
        $class = New-Object System.Text.StringBuilder 256
        [void][DockNative]::GetClassNameW($h, $class, 256)
        if ($class.ToString() -ne 'Chrome_WidgetWin_1') { return $true }
        $windowPid = 0
        [void][DockNative]::GetWindowThreadProcessId($h, [ref]$windowPid)
        try {
          $cmd = $script:processCommands[[int]$windowPid]
          if ($cmd -and $cmd.Contains($profile)) {
            $r = New-Object DockNative+RECT
            [void][DockNative]::GetWindowRect($h, [ref]$r)
            $w = $r.R - $r.L
            $ht = $r.B - $r.T
            # A 1x1 window is a Chromium helper, not the browser surface: docking that
            # phantom would put an invisible window on the panel and show nothing.
            if ($w -lt 200 -or $ht -lt 120) { return $true }
            $area = $w * $ht
            $score = 0
            if ($wantTitle -ne '' -and $text.ToString().Contains($wantTitle)) { $score += 1000000000 }
            if ($wantW -gt 0) {
              $delta = [Math]::Abs($w - $wantW) + [Math]::Abs($ht - $wantH) + [Math]::Abs($r.L - $wantX) + [Math]::Abs($r.T - $wantY)
              if ($delta -le ($tolerance * 4)) { $score += (1000000 - $delta) }
            }
            if ($score -le 0) { $score = $area }
            # Visibility only breaks ties: the sidebar hides its browser, and a hidden
            # carrier must still be adoptable by title/rect.
            if ([DockNative]::IsWindowVisible($h)) { $score += 5000 }
            if ($score -gt $script:bestScore) {
              $script:bestScore = $score
              $script:bestInfo = @{ hwnd = $h.ToInt64(); title = $text.ToString(); x = $r.L; y = $r.T; w = $w; h = $ht; visible = [DockNative]::IsWindowVisible($h) }
            }
          }
        } catch {}
        return $true
      }
      [void][DockNative]::EnumWindows($cb, [IntPtr]::Zero)
      $info = $script:bestInfo
      if ($info -eq $null) { return @{ ok = $false } }
      return @{
        ok = $true; hwnd = $info.hwnd; title = $info.title;
        x = $info.x; y = $info.y; w = $info.w; h = $info.h;
        visible = $info.visible
      }
    }
    'place' {
      $h = [IntPtr][long]$request.hwnd
      if (-not [DockNative]::IsWindow($h)) { return @{ ok = $false; error = 'not a window' } }
      if ($request.owner -and [long]$request.owner -ne 0) {
        [void][DockNative]::SetWindowLongPtr($h, $GWL_HWNDPARENT, [IntPtr][long]$request.owner)
      }
      $ex = [DockNative]::GetWindowLongPtr($h, $GWL_EXSTYLE).ToInt64()
      [void][DockNative]::SetWindowLongPtr($h, $GWL_EXSTYLE, [IntPtr]($ex -bor $WS_EX_TOOLWINDOW))
      $after = if ($request.after -and [long]$request.after -ne 0) { [IntPtr][long]$request.after } else { [IntPtr]::Zero }
      [void][DockNative]::SetWindowPos($h, $after, [int]$request.x, [int]$request.y, [int]$request.w, [int]$request.h,
        ($SWP_NOACTIVATE -bor $SWP_FRAMECHANGED -bor $SWP_SHOWWINDOW))
      return @{ ok = $true }
    }
    'move' {
      $h = [IntPtr][long]$request.hwnd
      if (-not [DockNative]::IsWindow($h)) { return @{ ok = $false; error = 'not a window' } }
      [void][DockNative]::SetWindowPos($h, [IntPtr]::Zero, [int]$request.x, [int]$request.y, [int]$request.w, [int]$request.h,
        ($SWP_NOACTIVATE -bor $SWP_NOZORDER -bor $SWP_SHOWWINDOW))
      return @{ ok = $true }
    }
    'hide' {
      $h = [IntPtr][long]$request.hwnd
      if (-not [DockNative]::IsWindow($h)) { return @{ ok = $false; error = 'not a window' } }
      [void][DockNative]::ShowWindow($h, 0)
      return @{ ok = $true }
    }
    'show' {
      $h = [IntPtr][long]$request.hwnd
      if (-not [DockNative]::IsWindow($h)) { return @{ ok = $false; error = 'not a window' } }
      # Show WITHOUT activating, and (when the owner is known) insert the window directly
      # above the owner instead of leaving it behind the app: SW_SHOWNOACTIVATE alone can
      # leave an owned window below its owner's z-order after the owner was activated.
      $after = if ($request.after -and [long]$request.after -ne 0) { [IntPtr][long]$request.after } else { [IntPtr]::Zero }
      $flags = $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE -bor $SWP_SHOWWINDOW
      [void][DockNative]::SetWindowPos($h, $after, 0, 0, 0, 0, $flags)
      return @{ ok = $true }
    }
    'follow' {
      # Glue the Edge window to the DSH window: (x,y,w,h) is the pane body in PHYSICAL
      # pixels relative to the DSH CLIENT origin. A native thread follows at ~120 Hz.
      $dsh = [IntPtr][long]$request.dsh
      $edge = [IntPtr][long]$request.edge
      if (-not [DockNative]::IsWindow($dsh) -or -not [DockNative]::IsWindow($edge)) {
        return @{ ok = $false; error = 'missing window' }
      }
      if ([FollowNative]::IsRunning()) {
        [FollowNative]::Update([int]$request.x, [int]$request.y, [int]$request.w, [int]$request.h)
      } else {
        [FollowNative]::Start($dsh, $edge, [int]$request.x, [int]$request.y, [int]$request.w, [int]$request.h)
      }
      return @{ ok = $true }
    }
    'unfollow' {
      [FollowNative]::Stop()
      return @{ ok = $true }
    }
    'close' {
      $h = [IntPtr][long]$request.hwnd
      if (-not [DockNative]::IsWindow($h)) { return @{ ok = $false; error = 'not a window' } }
      [void][DockNative]::PostMessageW($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
      return @{ ok = $true }
    }
    'active' {
      $h = [IntPtr][long]$request.hwnd
      return @{ ok = $true; active = ([DockNative]::GetForegroundWindow() -eq $h) }
    }
    'find-title' {
      # Owner fallback: when the plugin does not run in the window-owning process,
      # `find` by pid returns nothing, and an unowned docked window would float over
      # other applications instead of hiding with DSH.
      $needle = [string]$request.title
      $script:titleHwnd = [IntPtr]::Zero
      $script:titleArea = 0
      $cb = [DockNative+EnumProc]{
        param($h, $p)
        if (-not [DockNative]::IsWindowVisible($h)) { return $true }
        $text = New-Object System.Text.StringBuilder 512
        [void][DockNative]::GetWindowTextW($h, $text, 512)
        if (-not $text.ToString().Contains($needle)) { return $true }
        $r = New-Object DockNative+RECT
        [void][DockNative]::GetWindowRect($h, [ref]$r)
        $area = ($r.R - $r.L) * ($r.B - $r.T)
        if ($area -gt $script:titleArea) { $script:titleArea = $area; $script:titleHwnd = $h }
        return $true
      }
      [void][DockNative]::EnumWindows($cb, [IntPtr]::Zero)
      return @{ ok = ($script:titleHwnd -ne [IntPtr]::Zero); hwnd = $script:titleHwnd.ToInt64() }
    }
    'owner' {
      $h = [IntPtr][long]$request.hwnd
      if (-not [DockNative]::IsWindow($h)) { return @{ ok = $false; error = 'not a window' } }
      return @{ ok = $true; owner = [DockNative]::GetWindowLongPtr($h, $GWL_HWNDPARENT).ToInt64() }
    }
    'embed' {
      # True embedding: the Edge window becomes a WS_CHILD of the DSH window, positioned in
      # the PARENT's client coordinates, so it is clipped by the app window and never
      # activates on its own.
      $h = [IntPtr][long]$request.hwnd
      $parentValue = if ($request.parent -ne $null -and [long]$request.parent -ne 0) { [long]$request.parent } else { [long]$request.owner }
      $parent = [IntPtr]$parentValue
      if (-not [DockNative]::IsWindow($h) -or -not [DockNative]::IsWindow($parent)) { return @{ ok = $false; error = 'missing window' } }
      $style = [DockNative]::GetWindowLongPtr($h, $GWL_STYLE).ToInt64()
      $child = (($style -band (-bnot $WS_POPUP)) -bor $WS_CHILD)
      [void][DockNative]::SetWindowLongPtr($h, $GWL_STYLE, [IntPtr]$child)
      [void][DockNative]::SetParent($h, $parent)
      [void][DockNative]::SetWindowPos($h, [IntPtr]::Zero, [int]$request.x, [int]$request.y, [int]$request.w, [int]$request.h, ($SWP_FRAMECHANGED -bor $SWP_SHOWWINDOW))
      return @{ ok = $true; parent = [DockNative]::GetParent($h).ToInt64() }
    }
    'detach' {
      $h = [IntPtr][long]$request.hwnd
      if (-not [DockNative]::IsWindow($h)) { return @{ ok = $false; error = 'not a window' } }
      $style = [DockNative]::GetWindowLongPtr($h, $GWL_STYLE).ToInt64()
      $top = (($style -band (-bnot $WS_CHILD)) -bor $WS_POPUP)
      [void][DockNative]::SetWindowLongPtr($h, $GWL_STYLE, [IntPtr]$top)
      [void][DockNative]::SetParent($h, [IntPtr]::Zero)
      [void][DockNative]::SetWindowPos($h, [IntPtr]::Zero, [int]$request.x, [int]$request.y, [int]$request.w, [int]$request.h, ($SWP_FRAMECHANGED -bor $SWP_NOACTIVATE))
      return @{ ok = $true }
    }
    'parent' {
      $h = [IntPtr][long]$request.hwnd
      if (-not [DockNative]::IsWindow($h)) { return @{ ok = $false; error = 'not a window' } }
      return @{ ok = $true; parent = [DockNative]::GetParent($h).ToInt64() }
    }
    'client-origin' {
      $h = [IntPtr][long]$request.hwnd
      if (-not [DockNative]::IsWindow($h)) { return @{ ok = $false; error = 'not a window' } }
      $point = New-Object DockNative+POINT
      $point.X = 0; $point.Y = 0
      [void][DockNative]::ClientToScreen($h, [ref]$point)
      return @{ ok = $true; x = $point.X; y = $point.Y }
    }
    'exists' {
      $h = [IntPtr][long]$request.hwnd
      return @{ ok = $true; exists = [DockNative]::IsWindow($h) }
    }
    'rect' {
      $h = [IntPtr][long]$request.hwnd
      if (-not [DockNative]::IsWindow($h)) { return @{ ok = $false; error = 'not a window' } }
      $r = New-Object DockNative+RECT
      [void][DockNative]::GetWindowRect($h, [ref]$r)
      $text = New-Object System.Text.StringBuilder 512
      [void][DockNative]::GetWindowTextW($h, $text, 512)
      return @{ ok = $true; x = $r.L; y = $r.T; w = ($r.R - $r.L); h = ($r.B - $r.T); visible = [DockNative]::IsWindowVisible($h); title = $text.ToString() }
    }
    'own' {
      # Make the docked browser an owned tool window without touching its position.
      # Owned windows stay above their owner and hide with it, yet only the window
      # REGION (see 'crop') is ever visible, so no browser chrome floats in the app.
      $h = [IntPtr][long]$request.hwnd
      if (-not [DockNative]::IsWindow($h)) { return @{ ok = $false; error = 'not a window' } }
      if ($request.owner -and [long]$request.owner -ne 0) {
        [void][DockNative]::SetWindowLongPtr($h, $GWL_HWNDPARENT, [IntPtr][long]$request.owner)
      }
      $ex = [DockNative]::GetWindowLongPtr($h, $GWL_EXSTYLE).ToInt64()
      [void][DockNative]::SetWindowLongPtr($h, $GWL_EXSTYLE, [IntPtr]($ex -bor $WS_EX_TOOLWINDOW))
      return @{ ok = $true }
    }
    'crop' {
      # Clip the browser window to one rectangle: the PAGE viewport inside it. The
      # title bar, tab strip and address bar live outside this region, so Windows does
      # not draw or hit-test them. The page itself stays a real Edge window: native
      # scrolling, input, IME, dialogs and downloads all keep working.
      $h = [IntPtr][long]$request.hwnd
      if (-not [DockNative]::IsWindow($h)) { return @{ ok = $false; error = 'not a window' } }
      $rw = [int]$request.rw
      $rh = [int]$request.rh
      if ($rw -lt 8 -or $rh -lt 8) { return @{ ok = $false; error = 'degenerate region' } }
      $rgn = [DockNative]::CreateRectRgn([int]$request.rx, [int]$request.ry, [int]$request.rx + $rw, [int]$request.ry + $rh)
      $set = [DockNative]::SetWindowRgn($h, $rgn, $true)
      # SetWindowRgn owns the region on success.
      return @{ ok = ($set -ne 0); rx = [int]$request.rx; ry = [int]$request.ry; rw = $rw; rh = $rh }
    }
    'uncrop' {
      $h = [IntPtr][long]$request.hwnd
      if (-not [DockNative]::IsWindow($h)) { return @{ ok = $false; error = 'not a window' } }
      [void][DockNative]::SetWindowRgn($h, [IntPtr]::Zero, $true)
      return @{ ok = $true }
    }
    'region' {
      $h = [IntPtr][long]$request.hwnd
      if (-not [DockNative]::IsWindow($h)) { return @{ ok = $false; error = 'not a window' } }
      $rgn = [DockNative]::CreateRectRgn(0, 0, 0, 0)
      $kind = [DockNative]::GetWindowRgn($h, $rgn)
      if ($kind -eq 0) { [void][DockNative]::DeleteObject($rgn); return @{ ok = $true; kind = 0 } }
      $box = New-Object DockNative+RECT
      [void][DockNative]::GetRgnBox($rgn, [ref]$box)
      [void][DockNative]::DeleteObject($rgn)
      return @{ ok = $true; kind = $kind; x = $box.L; y = $box.T; w = ($box.R - $box.L); h = ($box.B - $box.T) }
    }
    'document-rect' {
      # The web-content rectangle in SCREEN pixels, straight from UI Automation. Unlike
      # guessing from outer/inner sizes, this stays correct when Edge shows vertical tabs
      # or a side panel (the viewport is then not horizontally centred in the window).
      $h = [IntPtr][long]$request.hwnd
      if (-not [DockNative]::IsWindow($h)) { return @{ ok = $false; error = 'not a window' } }
      try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
        if ($root -eq $null) { return @{ ok = $false; error = 'no automation root' } }
        $cond = New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::Document)
        $doc = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        if ($doc -eq $null) { return @{ ok = $false; error = 'no document' } }
        $rect = $doc.Current.BoundingRectangle
        if ($rect.Width -lt 20 -or $rect.Height -lt 20) { return @{ ok = $false; error = 'empty document rect' } }
        return @{
          ok = $true;
          x = [int]$rect.X; y = [int]$rect.Y; w = [int]$rect.Width; h = [int]$rect.Height;
          name = $doc.Current.Name
        }
      } catch { return @{ ok = $false; error = $_.Exception.Message } }
    }
    default { return @{ ok = $false; error = "unknown op: $($request.op)" } }
  }
}

function Write-Reply($reply) {
  $json = $reply | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

if ($Op -eq 'stdio') {
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($line -eq $null) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }
    try {
      $request = $line | ConvertFrom-Json
      $reply = Invoke-Op $request
      # Echo the request id so a multiplexing caller can correlate out-of-order replies.
      if ($request.id -ne $null) { $reply.id = $request.id }
      Write-Reply $reply
    } catch {
      $reply = @{ ok = $false; error = $_.Exception.Message }
      if ($request -ne $null -and $request.id -ne $null) { $reply.id = $request.id }
      Write-Reply $reply
    }
  }
  exit 0
}

if ($Op -eq 'noop') { Write-Reply @{ ok = $true }; exit 0 }

$request = @{ op = $Op; hwnd = $Hwnd; x = $X; y = $Y; w = $W; h = $H; owner = $Owner; pid = $ProcessId; profile = $Profile; title = $Title }
Write-Reply (Invoke-Op $request)
