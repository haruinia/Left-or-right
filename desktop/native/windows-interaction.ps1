$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Concurrent;
using System.Threading;
public static class LeftOrRightInteraction {
    private static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
    public static volatile bool InputClosed;
    public static void StartInput() {
        // Console.In.ReadLineAsync can block on .NET Framework's synchronized reader.
        var reader = new Thread(() => {
            try {
                string line;
                while ((line = Console.In.ReadLine()) != null) Commands.Enqueue(line);
            } catch {} finally { InputClosed = true; }
        });
        reader.IsBackground = true;
        reader.Start();
    }
    public static string NextCommand() {
        string line;
        return Commands.TryDequeue(out line) ? line : null;
    }
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    public static bool ControlHeld() {
        return (GetAsyncKeyState(0xA2) & 0x8000) != 0 || (GetAsyncKeyState(0xA3) & 0x8000) != 0;
    }
}
'@

$last = $null
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$lastHeartbeat = -1000
[LeftOrRightInteraction]::StartInput()
while (-not [LeftOrRightInteraction]::InputClosed) {
    $line = [LeftOrRightInteraction]::NextCommand()
    while ($null -ne $line) {
        try {
            $command = $line | ConvertFrom-Json
            $target = [long]0
            $expected = [long]0
            if ([long]::TryParse([string]$command.restore, [ref]$target) -and
                [long]::TryParse([string]$command.expected, [ref]$expected) -and
                $target -gt 0 -and $expected -gt 0 -and
                [LeftOrRightInteraction]::GetForegroundWindow().ToInt64() -eq $expected -and
                [LeftOrRightInteraction]::IsWindow([IntPtr]$target)) {
                [void][LeftOrRightInteraction]::SetForegroundWindow([IntPtr]$target)
            }
        } catch {}
        $line = [LeftOrRightInteraction]::NextCommand()
    }
    $foreground = [LeftOrRightInteraction]::GetForegroundWindow().ToInt64()
    $held = $foreground -ne 0 -and [LeftOrRightInteraction]::ControlHeld()
    if ($last -ne $held -or $clock.ElapsedMilliseconds - $lastHeartbeat -ge 250) {
        @{held = [bool]$held; foreground = $foreground.ToString([System.Globalization.CultureInfo]::InvariantCulture)} |
            ConvertTo-Json -Compress | ForEach-Object { [Console]::Out.WriteLine($_) }
        [Console]::Out.Flush()
        $last = $held
        $lastHeartbeat = $clock.ElapsedMilliseconds
    }
    Start-Sleep -Milliseconds 20
}
