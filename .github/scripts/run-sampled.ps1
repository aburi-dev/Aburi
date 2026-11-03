# Runs `pnpm <task>` with the flags in TURBO_ARGS while a thread of this process samples the runner.
# Once a process on a Windows runner fails to initialise (0xC0000142), no new process starts there, not
# even a step that would look. This process is already running, so its samples still show what the
# runner held when that happened.
param([Parameter(Mandatory)] [string] $Task)

# The workflow's shell stops at the first error, and a failed sample must not cost the task's exit code.
$ErrorActionPreference = 'Continue'

Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;

public static class RunnerMemory
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Status
    {
        public uint Length;
        public uint Load;
        public ulong TotalPhys;
        public ulong AvailPhys;
        public ulong TotalPageFile;
        public ulong AvailPageFile;
        public ulong TotalVirtual;
        public ulong AvailVirtual;
        public ulong AvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx(ref Status status);

    public static Status Read()
    {
        var status = new Status { Length = (uint)Marshal.SizeOf<Status>() };
        GlobalMemoryStatusEx(ref status);
        return status;
    }
}
'@

$sampler = Start-ThreadJob {
    while ($true) {
        try {
            $processes = [System.Diagnostics.Process]::GetProcesses()
            $memory = [RunnerMemory]::Read()
            [pscustomobject]@{
                Time           = Get-Date -Format 'HH:mm:ss'
                Processes      = $processes.Count
                Handles        = ($processes | Measure-Object -Property HandleCount -Sum).Sum
                CommitFreeMB   = [math]::Round($memory.AvailPageFile / 1MB)
                PhysicalFreeMB = [math]::Round($memory.AvailPhys / 1MB)
                Most           = ($processes | Group-Object ProcessName | Sort-Object Count -Descending |
                        Select-Object -First 6 | ForEach-Object { "$($_.Name) $($_.Count)" }) -join ', '
            }
        } catch {
            [pscustomobject]@{ Time = Get-Date -Format 'HH:mm:ss'; Most = "sample failed: $_" }
        }
        Start-Sleep -Seconds 5
    }
}

$turboArgs = @($env:TURBO_ARGS -split ' ' | Where-Object { $_ })
try {
    pnpm $Task @turboArgs
    $code = $LASTEXITCODE ?? 1
} catch {
    Write-Host "pnpm $Task did not start: $_"
    $code = 1
}

Stop-Job $sampler
$all = @(Receive-Job $sampler -ErrorAction SilentlyContinue)
Remove-Job $sampler -Force
$samples = @($all | Where-Object { $null -ne $_.Processes })

if ($samples.Count -gt 0) {
    $busiest = $samples | Sort-Object Processes -Descending | Select-Object -First 1
    $handles = ($samples | Measure-Object Handles -Maximum).Maximum
    $commit = ($samples | Measure-Object CommitFreeMB -Minimum).Minimum
    Write-Host "Runner over $($samples.Count) samples: at most $($busiest.Processes) processes and $handles handles, at least $commit MB of commit free. Busiest moment: $($busiest.Most)"
}
if ($code -ne 0) {
    Write-Host "The runner in the minute before pnpm $Task exited with $($code):"
    $all | Select-Object -Last 12 |
        Format-Table Time, Processes, Handles, CommitFreeMB, PhysicalFreeMB, Most -AutoSize -Wrap |
        Out-String -Width 400 | Write-Host
}
exit $code
