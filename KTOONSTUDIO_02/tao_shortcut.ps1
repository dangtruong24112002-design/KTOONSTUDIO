# Creates KTOONSTUDIO shortcuts (Desktop + Start menu) with the app icon.
$d = $PSScriptRoot
$ws = New-Object -ComObject WScript.Shell
$targets = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'))
foreach ($p in $targets) {
  $s = $ws.CreateShortcut((Join-Path $p 'KTOONSTUDIO.lnk'))
  $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $s.Arguments = '"' + (Join-Path $d 'KTOONSTUDIO.vbs') + '"'
  $s.WorkingDirectory = $d
  $s.IconLocation = (Join-Path $d 'ktoonstudio.ico') + ',0'
  $s.Description = 'KTOONSTUDIO'
  $s.Save()
}
Write-Host 'Done: KTOONSTUDIO shortcut created on the Desktop and in the Start menu.'
Write-Host 'Tip: open it, then right-click its taskbar icon > Pin to taskbar.'
