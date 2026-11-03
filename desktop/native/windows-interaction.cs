using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class LeftOrRightInteraction
{
    private static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
    private static volatile bool inputClosed;

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    private static bool ControlHeld()
    {
        return (GetAsyncKeyState(0xA2) & 0x8000) != 0 || (GetAsyncKeyState(0xA3) & 0x8000) != 0;
    }

    private static void StartInput()
    {
        var reader = new Thread(() =>
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    if (line.Length <= 4096) Commands.Enqueue(line);
                }
            }
            catch (IOException) { }
            finally { inputClosed = true; }
        });
        reader.IsBackground = true;
        reader.Start();
    }

    private static void RestoreForeground(string line, JavaScriptSerializer serializer)
    {
        try
        {
            var command = serializer.Deserialize<Dictionary<string, object>>(line);
            object targetValue;
            object expectedValue;
            long target;
            long expected;
            if (command == null || !command.TryGetValue("restore", out targetValue) || !command.TryGetValue("expected", out expectedValue)) return;
            if (!long.TryParse(Convert.ToString(targetValue, CultureInfo.InvariantCulture), NumberStyles.None, CultureInfo.InvariantCulture, out target) ||
                !long.TryParse(Convert.ToString(expectedValue, CultureInfo.InvariantCulture), NumberStyles.None, CultureInfo.InvariantCulture, out expected)) return;
            if (target <= 0 || expected <= 0 || GetForegroundWindow().ToInt64() != expected) return;
            var window = new IntPtr(target);
            if (IsWindow(window)) SetForegroundWindow(window);
        }
        catch (ArgumentException) { }
        catch (InvalidOperationException) { }
        catch (OverflowException) { }
    }

    private static int Main()
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        var serializer = new JavaScriptSerializer();
        var clock = Stopwatch.StartNew();
        long lastHeartbeat = -250;
        bool? lastHeld = null;
        StartInput();
        try
        {
            while (!inputClosed)
            {
                string command;
                while (Commands.TryDequeue(out command)) RestoreForeground(command, serializer);
                long foreground = GetForegroundWindow().ToInt64();
                bool held = foreground != 0 && ControlHeld();
                if (!lastHeld.HasValue || lastHeld.Value != held || clock.ElapsedMilliseconds - lastHeartbeat >= 250)
                {
                    Console.Out.WriteLine(serializer.Serialize(new Dictionary<string, object>
                    {
                        { "held", held },
                        { "foreground", foreground.ToString(CultureInfo.InvariantCulture) }
                    }));
                    Console.Out.Flush();
                    lastHeld = held;
                    lastHeartbeat = clock.ElapsedMilliseconds;
                }
                Thread.Sleep(20);
            }
        }
        catch (IOException) { return 1; }
        return 0;
    }
}
