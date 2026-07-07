#define MyAppName "CXX"
#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#ifndef SourceRoot
  #define SourceRoot "C:\CXX\dist\win\CXX"
#endif
#ifndef OutputDir
  #define OutputDir "C:\CXX\dist\win\installer"
#endif
#ifndef OutputBaseFilename
  #define OutputBaseFilename "CXX-{#MyAppVersion}-win-x64"
#endif
#ifndef IconFile
  #define IconFile "C:\CXX\packaging\windows\cxx.ico"
#endif

[Setup]
AppId={{8E5F7645-5E87-48D1-A3F5-6C26A8C66E4F}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=CXX
DefaultDirName={localappdata}\Programs\CXX
DefaultGroupName=CXX
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename={#OutputBaseFilename}
OutputDir={#OutputDir}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\CXX.exe
Compression=lzma
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
CloseApplications=no

[Files]
Source: "{#SourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\CXX"; Filename: "{app}\CXX.exe"; Parameters: "--pair"; WorkingDir: "{app}"; IconFilename: "{app}\CXX.exe"
Name: "{autodesktop}\CXX"; Filename: "{app}\CXX.exe"; Parameters: "--pair"; WorkingDir: "{app}"; IconFilename: "{app}\CXX.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[Run]
Filename: "{app}\CXX.exe"; Parameters: "--pair"; Description: "Launch CXX"; WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{sys}\schtasks.exe"; Parameters: "/End /TN CXXRemote"; Flags: runhidden; RunOnceId: "EndCXXRemoteTask"
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /TN CXXRemote /F"; Flags: runhidden; RunOnceId: "DelCXXRemoteTask"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM CXX.exe /T"; Flags: runhidden; RunOnceId: "KillCXX"

[Code]
procedure StopCXXProcesses;
var
  ResultCode: Integer;
  AppDir, PsCmd: String;
begin
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/End /TN CXXRemote', '',
       SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/Delete /TN CXXRemote /F', '',
       SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM CXX.exe /T', '',
       SW_HIDE, ewWaitUntilTerminated, ResultCode);

  AppDir := ExpandConstant('{app}');
  if AppDir <> '' then
  begin
    StringChangeEx(AppDir, '''', '''''', True);
    PsCmd :=
      'Get-CimInstance Win32_Process | Where-Object { ' +
      '$_.Name -eq ''cxx-daemon.exe'' -and $_.ExecutablePath -and ' +
      '$_.ExecutablePath -like ''' + AppDir + '\*'' } | ' +
      'ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }';
    Exec('powershell.exe',
         '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + PsCmd + '"',
         '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopCXXProcesses;
  Sleep(1000);
  Result := '';
end;
