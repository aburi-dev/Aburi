# Runs `pnpm <task>` with the flags in TURBO_ARGS while a thread of this process samples the runner.
# Once a process on a Windows runner fails to initialise (0xC0000142), no new process starts there, not
# even a step that would look. This process is already running, so its samples and its read of the System
# log still show what the runner held when that happened.
param([Parameter(Mandatory)] [string] $Task)

# The workflow's shell stops at the first error, and the report after the task must still run and keep the
# task's exit code.
$ErrorActionPreference = 'Continue'
$started = Get-Date
# Desktop heap belongs to a session's desktop, so the processes that pile up are counted by session.
$session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId

Add-Type -TypeDefinition @'
using System.ComponentModel;
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
        if (!GlobalMemoryStatusEx(ref status)) throw new Win32Exception();
        return status;
    }
}
'@

$sampler = Start-ThreadJob {
    $session = $using:session
    while ($true) {
        $sample = [ordered]@{
            Time = Get-Date -Format 'HH:mm:ss'; Processes = $null; Handles = $null; InSession = $null
            CommitFreeMB = $null; PhysicalFreeMB = $null; Most = $null; Failed = $null
        }
        $failures = @()
        try {
            $processes = [System.Diagnostics.Process]::GetProcesses()
            $mine = @($processes | Where-Object SessionId -EQ $session)
            $sample.Processes = $processes.Count
            $sample.Handles = [long]($processes | Measure-Object -Property HandleCount -Sum).Sum
            $sample.InSession = $mine.Count
            $sample.Most = ($mine | Group-Object ProcessName | Sort-Object Count -Descending |
                    Select-Object -First 6 | ForEach-Object { "$($_.Name) $($_.Count)" }) -join ', '
        } catch {
            $failures += "processes: $_"
        }
        try {
            $memory = [RunnerMemory]::Read()
            $sample.CommitFreeMB = [long]($memory.AvailPageFile / 1MB)
            $sample.PhysicalFreeMB = [long]($memory.AvailPhys / 1MB)
        } catch {
            $failures += "memory: $_"
        }
        $sample.Failed = $failures -join '; '
        [pscustomobject]$sample
        Start-Sleep -Seconds 5
    }
}

function Show-SystemEvents([string] $Heading, [hashtable] $Filter) {
    Write-Host $Heading
    try {
        Get-WinEvent -MaxEvents 50 -ErrorAction Stop -FilterHashtable (@{ LogName = 'System' } + $Filter) |
            Format-List TimeCreated, ProviderName, Id, Message | Out-String -Width 400 | Write-Host
    } catch {
        if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') {
            Write-Host 'None.'
        } else {
            Write-Host "The System log could not be read: $_"
        }
    }
}

$turboArgs = @($env:TURBO_ARGS -split ' ' | Where-Object { $_ })
$code = $null
try {
    pnpm $Task @turboArgs
    $code = $LASTEXITCODE ?? 1
} catch {
    Write-Host "pnpm $Task did not start: $_"
    $code = 1
} finally {
    # Here rather than after the task, so a step that is cancelled or times out still reports.
    $all = @()
    $state = 'never started'
    if ($sampler) {
        $state = $sampler.State
        Stop-Job $sampler
        $all = @(Receive-Job $sampler)
    }

    $samples = @($all | Where-Object { $null -ne $_.Processes })
    if ($samples.Count -gt 0) {
        $busiest = $samples | Sort-Object InSession -Descending | Select-Object -First 1
        $processes = ($samples | Measure-Object Processes -Maximum).Maximum
        $handles = ($samples | Measure-Object Handles -Maximum).Maximum
        $withMemory = @($samples | Where-Object { $null -ne $_.CommitFreeMB })
        $commit = if ($withMemory.Count -gt 0) {
            "$(($withMemory | Measure-Object CommitFreeMB -Minimum).Minimum) MB"
        } else { 'an unknown amount' }
        Write-Host "Runner over $($samples.Count) samples: at most $processes processes and $handles handles, at most $($busiest.InSession) processes in session $session, at least $commit of commit free. Busiest moment in session $($session): $($busiest.Most)"
    } else {
        $first = ($all | Where-Object Failed | Select-Object -First 1).Failed
        Write-Host "The sampler recorded no process counts. Its job was $state; the first failure it recorded: $($first ?? 'none')"
    }

    if ($code -ne 0) {
        $outcome = if ($null -eq $code) { 'was stopped' } else { "exited with $code" }
        Write-Host "The runner while pnpm $Task ran, which $($outcome):"
        $all | Format-Table Time, Processes, Handles, InSession, CommitFreeMB, PhysicalFreeMB, Most, Failed -AutoSize -Wrap |
            Out-String -Width 400 | Write-Host
        # Windows logs a failed desktop heap allocation once per session, so it may predate this task.
        Show-SystemEvents 'Events 243 and 244 in the System log, which Win32k writes when desktop heap runs out:' @{ Id = 243, 244 }
        Show-SystemEvents "Warnings and errors in the System log since pnpm $Task started:" @{
            Level = 1, 2, 3; StartTime = $started
        }
    }
}
exit ($code ?? 1)
