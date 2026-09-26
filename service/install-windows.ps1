param([string]$NodeExe,[string]$Cli,[string]$Config,[string]$Name)
$ErrorActionPreference='Stop'
$env:PSModulePath=$PSHOME+'\Modules;'+$env:SystemRoot+'\System32\WindowsPowerShell\v1.0\Modules'
foreach($value in @($NodeExe,$Cli,$Config)) { if($value.Contains('"')) {throw 'INVALID_PATH'} }
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$action=New-ScheduledTaskAction -Execute $NodeExe -Argument ('"'+$Cli+'" start --config "'+$Config+'"')
$trigger=@(
    (New-ScheduledTaskTrigger -AtLogOn -User $user),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1))
)
# RestartOnFailure alone does not cover a clean exit. IgnoreNew makes the
# periodic trigger a liveness check, without replacing a healthy process.
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $Name
