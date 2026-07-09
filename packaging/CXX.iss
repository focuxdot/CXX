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
; 装/卸时改了用户 PATH（加/去 {app}），让资源管理器广播环境变量变更，新开的终端即时生效。
ChangesEnvironment=yes

[Files]
Source: "{#SourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\CXX"; Filename: "{app}\CXX.exe"; Parameters: "--pair"; WorkingDir: "{app}"; IconFilename: "{app}\CXX.exe"
Name: "{autodesktop}\CXX"; Filename: "{app}\CXX.exe"; Parameters: "--pair"; WorkingDir: "{app}"; IconFilename: "{app}\CXX.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[Registry]
; 全局 `cxx` 命令：把 {app}（含 cxx.cmd → resources\cxx-daemon.exe）加进用户 PATH。
; 仅在尚未包含时追加，避免重复安装把 PATH 撑肥；卸载时由 [Code] 精确摘除本条目。
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; \
  ValueData: "{olddata};{app}"; Flags: preservestringtype; Check: NeedsAddPath('{app}')

[Run]
Filename: "{app}\CXX.exe"; Parameters: "--pair"; Description: "Launch CXX"; WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{sys}\schtasks.exe"; Parameters: "/End /TN CXXRemote"; Flags: runhidden; RunOnceId: "EndCXXRemoteTask"
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /TN CXXRemote /F"; Flags: runhidden; RunOnceId: "DelCXXRemoteTask"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM CXX.exe /T"; Flags: runhidden; RunOnceId: "KillCXX"

[Code]
// PATH 里是否还没有 {app}（分号包裹后大小写不敏感地子串匹配，避免重复追加）。
function NeedsAddPath(Param: String): Boolean;
var
  OrigPath: String;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Lowercase(Param) + ';', ';' + Lowercase(OrigPath) + ';') = 0;
end;

// 卸载时只摘掉我们加的 {app} 段，绝不动整条 PATH。
procedure RemoveFromPath(Param: String);
var
  OrigPath, NewPath: String;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
    exit;
  NewPath := ';' + OrigPath + ';';
  StringChangeEx(NewPath, ';' + Param + ';', ';', True);
  // 去掉前面补的两个哨兵分号
  if (Length(NewPath) >= 1) and (NewPath[1] = ';') then
    Delete(NewPath, 1, 1);
  if (Length(NewPath) >= 1) and (NewPath[Length(NewPath)] = ';') then
    Delete(NewPath, Length(NewPath), 1);
  RegWriteExpandStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', NewPath);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RemoveFromPath(ExpandConstant('{app}'));
end;

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
