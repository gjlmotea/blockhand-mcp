# Background key delivery to Minecraft Education on Windows. Called by game-keys.mjs, which
# validates every argument (names, lengths, counts) before this script runs.
#
# PostMessage puts a message into the game window's queue without changing focus, so the
# person at the computer keeps whatever window they are working in. A successful post means
# the message was queued, not that the game acted on it: confirm the result on screen or
# through MCP.
#
# Measured on Minecraft Education 1.26.32 (Win32 build, window class OGLES): keyboard
# messages reached the chat bar, the pause menu and the world list while another app had
# focus. Mouse buttons posted this way did not mine blocks, so this tool sends no mouse input.

param(
    [switch]$Probe,
    [string]$Keys = '',
    [string]$Text = '',
    [switch]$OpenChat,
    [string]$Send = '',
    [string]$Chat = '',
    [int]$TargetPid = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class GameKeys {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP   = 0x0101;
    public const uint WM_CHAR    = 0x0102;

    public static string TitleOf(IntPtr h) {
        StringBuilder sb = new StringBuilder(256);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }
    public static string ClassOf(IntPtr h) {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }
    public static uint PidOf(IntPtr h) {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        return pid;
    }
}
'@

function Fail([string]$code, [string]$detail = '') {
    Write-Output ('ERROR=' + $code)
    if ($detail -ne '') { Write-Output ('detail=' + $detail) }
    exit 1
}

# ---- pick exactly one target window ---------------------------------------
# Only the Education edition: process Minecraft.Windows whose executable reports the product
# name "Minecraft Education" (the regular Bedrock game uses the same process name), with a
# window of class OGLES. Never guess between several: the caller names one by PID.
$unreadable = 0
$candidates = @(Get-Process -Name 'Minecraft.Windows' -ErrorAction SilentlyContinue | Where-Object {
    $product = ''
    try { $product = $_.MainModule.FileVersionInfo.ProductName } catch { $script:unreadable++ }
    $_.MainWindowHandle -ne [IntPtr]::Zero -and
    $product -like '*Minecraft Education*' -and
    [GameKeys]::ClassOf($_.MainWindowHandle) -eq 'OGLES'
})
if ($TargetPid -ne 0) { $candidates = @($candidates | Where-Object { $_.Id -eq $TargetPid }) }
if ($candidates.Count -eq 0) {
    $why = 'no Minecraft Education window (process Minecraft.Windows, product Minecraft Education, class OGLES)'
    if ($unreadable -gt 0) { $why += '; ' + $unreadable + ' game process(es) could not be inspected (running elevated?)' }
    Fail 'game_not_found' $why
}
if ($candidates.Count -gt 1) { Fail 'multiple_games' ('pass --pid with one of: ' + (($candidates | ForEach-Object { $_.Id }) -join ',')) }

$proc = $candidates[0]
$mc = $proc.MainWindowHandle

Write-Output ('pid=' + $proc.Id)
Write-Output ('title=' + [GameKeys]::TitleOf($mc))
Write-Output ('class=' + [GameKeys]::ClassOf($mc))
Write-Output ('minimized=' + [GameKeys]::IsIconic($mc))
$before = [GameKeys]::GetForegroundWindow()
Write-Output ('foreground_before=' + [GameKeys]::TitleOf($before))
Write-Output ('game_was_foreground=' + ($before -eq $mc))

if ($Probe) { exit 0 }

# A minimised game has not been verified to accept posted input. Refuse rather than guess.
if ([GameKeys]::IsIconic($mc)) { Fail 'game_minimized' 'restore the game window first; minimised input is unverified' }

# ---- one sender at a time --------------------------------------------------
# A named mutex belongs to this process: the system releases it when the process ends, even
# if it is killed, so a crashed sender never leaves a stale lock and no caller has to decide
# whether someone else's lock is dead. It covers one call only; between calls (open the chat
# bar, take a screenshot, send) another agent could still interleave.
$mutex = New-Object System.Threading.Mutex($false, 'Local\BlockHandGameKeys')
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) { Fail 'busy' 'another blockhand-keys call is sending keys; wait for it to finish' }

# Stop between whole key operations once this much time has passed, so the caller's outer
# timeout (20 s) is only a safety net and never cuts a key between its down and up messages.
$deadline = [DateTime]::UtcNow.AddSeconds(12)
function Assert-Time {
    if ([DateTime]::UtcNow -gt $script:deadline) { Fail 'deadline' 'stopped between keys; send the rest in another call' }
}

$VK = @{
    'escape' = 0x1B; 'return' = 0x0D; 'enter' = 0x0D; 'tab' = 0x09; 'shift' = 0x10;
    'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28; 't' = 0x54
}

# Re-check the target before every message: the window can close or be replaced mid-call.
function Test-Target {
    return ([GameKeys]::IsWindow($mc) -and [GameKeys]::PidOf($mc) -eq [uint32]$proc.Id)
}
function Assert-Target {
    if (-not [GameKeys]::IsWindow($mc)) { Fail 'window_gone' }
    if ([GameKeys]::PidOf($mc) -ne [uint32]$proc.Id) { Fail 'window_changed_owner' }
}

function Post([uint32]$msg, [int]$wparam, [string]$label) {
    Assert-Target
    if (-not [GameKeys]::PostMessage($mc, $msg, [IntPtr]$wparam, [IntPtr]0)) {
        Fail 'post_failed' ($label + ' win32=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
}

# Key-up in a finally block: posted after a key-down even if something fails in between.
# It is checked like every other message, and a failure is reported instead of ignored.
function Release([int]$vk, [string]$label) {
    if (-not (Test-Target)) { Write-Output ('release_skipped=' + $label + ' (window gone or changed owner)'); return }
    if (-not [GameKeys]::PostMessage($mc, [GameKeys]::WM_KEYUP, [IntPtr]$vk, [IntPtr]0)) {
        Write-Output ('release_failed=' + $label + ' win32=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
}

function Post-Key([string]$name) {
    Assert-Time
    $vk = $VK[$name]
    Post ([GameKeys]::WM_KEYDOWN) $vk $name
    try {
        Start-Sleep -Milliseconds 60
    } finally {
        Release $vk $name
    }
    Start-Sleep -Milliseconds 120
}

function Post-Combo([string]$combo) {
    Assert-Time
    $names = $combo.Split('+')
    $mods = @($names[0..($names.Length - 2)])
    $key = $names[-1]
    $held = New-Object System.Collections.ArrayList
    try {
        foreach ($m in $mods) {
            Post ([GameKeys]::WM_KEYDOWN) $VK[$m] $m
            [void]$held.Add($m)
            Start-Sleep -Milliseconds 40
        }
        $vk = $VK[$key]
        Post ([GameKeys]::WM_KEYDOWN) $vk $key
        try { Start-Sleep -Milliseconds 60 } finally { Release $vk $key }
    } finally {
        # Release only the modifiers that were actually pressed, in reverse order.
        for ($i = $held.Count - 1; $i -ge 0; $i--) { Release $VK[$held[$i]] $held[$i] }
    }
    Start-Sleep -Milliseconds 120
}

function Post-Text([string]$s) {
    Assert-Time
    foreach ($ch in $s.ToCharArray()) {
        Post ([GameKeys]::WM_CHAR) ([int][char]$ch) 'char'
        Start-Sleep -Milliseconds 12
    }
}

# ---- actions (arguments were validated by game-keys.mjs) -------------------
try {
    if ($OpenChat -or $Chat -ne '') {
        Post-Key 't'
        Write-Output 'posted_open_chat=t'
    }
    if ($Chat -ne '') {
        # Precondition, stated in the usage: the game is in a world with no screen open. If the
        # chat bar did not open, these characters would reach the game as hotkeys.
        Start-Sleep -Milliseconds 450
        Post-Text $Chat
        Start-Sleep -Milliseconds 200
        Post-Key 'return'
        Write-Output ('posted_chat_len=' + $Chat.Length)
    }
    if ($Send -ne '') {
        Post-Text $Send
        Start-Sleep -Milliseconds 200
        Post-Key 'return'
        Write-Output ('posted_send_len=' + $Send.Length)
    }
    foreach ($k in ($Keys -split ',' | Where-Object { $_ -ne '' })) {
        $name = $k.Trim().ToLower()
        if ($name.Contains('+')) { Post-Combo $name } else { Post-Key $name }
        Write-Output ('posted_key=' + $name)
    }
    if ($Text -ne '') {
        Post-Text $Text
        Write-Output ('posted_text_len=' + $Text.Length)
    }

    Start-Sleep -Milliseconds 300
    $after = [GameKeys]::GetForegroundWindow()
    Write-Output ('foreground_after=' + [GameKeys]::TitleOf($after))
    # Same window before and after only shows these two samples matched; it does not prove the
    # game acted, and the person may switch windows themselves. Never "fix" focus by force.
    Write-Output ('focus_unchanged=' + ($after -eq $before))
    Write-Output 'note=messages were queued; confirm the result on screen or through MCP'
} finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
