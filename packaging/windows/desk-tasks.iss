; desk-tasks-setup.exe: a per-user install (no administrator rights) into
; %LOCALAPPDATA%\Programs\desk-tasks. packaging/windows/build.py stages the files and passes
; AppVersion, SourceDir, OutputDir and the images.
;
; Each version gets its own folder (app-<version>), so an update never overwrites the files of
; the running one, and a failed update leaves the old version as it was. Before installing,
; a running desk-tasks is asked to quit the way tray Quit does (it saves first). The in-app
; updater runs this silently with /relaunch: desk-tasks starts again when it is done, also
; after a failure.

#ifndef AppVersion
  #error Build with packaging/windows/build.py
#endif

#define AppName "desk-tasks"
#define AppDir "app-" + AppVersion
#define Exe "{app}\" + AppDir + "\pythonw.exe"

[Setup]
AppId={{6B9E2D47-3C1A-4F58-9E0B-7D2C5A1F8E34}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Matthias Ley
AppPublisherURL=https://github.com/Mnikley/desk-tasks
AppSupportURL=https://github.com/Mnikley/desk-tasks/issues
AppUpdatesURL=https://github.com/Mnikley/desk-tasks/releases
AppCopyright=Matthias Ley, MIT licence
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} installer
PrivilegesRequired=lowest
DefaultDirName={autopf}\{#AppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
AlwaysShowDirOnReadyPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
OutputDir={#OutputDir}
OutputBaseFilename=desk-tasks-setup
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\desk-tasks.ico
UninstallDisplayName={#AppName}
WizardStyle=modern
WizardSmallImageFile={#SmallImage}
WizardImageFile={#LargeImage}
Compression=lzma2/ultra64
SolidCompression=yes
; Nothing is replaced in place (new versions get a new folder); the app is closed in [Code].
CloseApplications=no
RestartApplications=no
SetupLogging=yes
#ifdef Sign
SignTool=desktasks
SignedUninstaller=yes
#endif

[Messages]
ReadyLabel2a=Click Install to put desk-tasks on your desktop. No administrator rights are needed.
FinishedHeadingLabel=desk-tasks is installed
FinishedLabelNoIcons=desk-tasks lives on your desktop, below your windows. Press Win+Alt+J to bring it to the front, Esc to send it back.
FinishedLabel=desk-tasks lives on your desktop, below your windows. Press Win+Alt+J to bring it to the front, Esc to send it back.
ClickFinish=Click Finish to close Setup. desk-tasks is in the Start menu too.

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}\{#AppDir}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#IconFile}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\desk-tasks"; Filename: "{#Exe}"; Parameters: "-m desk_tasks --show"; WorkingDir: "{app}"; IconFilename: "{app}\desk-tasks.ico"; Comment: "Your Nextcloud tasks on the desktop"; AppUserModelID: "DeskTasks"

[Run]
Filename: "{#Exe}"; Parameters: "-m desk_tasks --show"; WorkingDir: "{app}"; Description: "Start desk-tasks"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; .pyc files Python wrote for modules the build didn't compile, and the version folders.
Type: filesandordirs; Name: "{app}\app-*"

[Code]
const
  ProbeClass = 'DeskTasksProbe';
  AppMutex = 'Local\desk-tasks';
  QuitMessage = 'desk-tasks-quit';
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
  WebView2Client = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  QuitWaitMs = 20000;
  PROCESS_TERMINATE = $0001;
  SYNCHRONIZE = $00100000;

var
  Installed: Boolean;
  ForgetData: Boolean;

function RegisterWindowMessage(Name: String): Longint;
  external 'RegisterWindowMessageW@user32.dll stdcall';
function GetWindowThreadProcessId(Wnd: HWND; var ProcessId: Cardinal): Cardinal;
  external 'GetWindowThreadProcessId@user32.dll stdcall';
function OpenProcess(Access: Cardinal; Inherit: Longint; Pid: Cardinal): Longint;
  external 'OpenProcess@kernel32.dll stdcall';
function TerminateProcess(Process: Longint; ExitCode: Cardinal): Longint;
  external 'TerminateProcess@kernel32.dll stdcall';
function WaitForSingleObject(Handle: Longint; Ms: Cardinal): Cardinal;
  external 'WaitForSingleObject@kernel32.dll stdcall';
function CloseHandle(Handle: Longint): Longint;
  external 'CloseHandle@kernel32.dll stdcall';

function IsRelaunch: Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), '/relaunch') = 0 then
      Result := True;
end;

function AppRunning: Boolean;
begin
  Result := CheckForMutexes(AppMutex);
end;

{ Asks a running desk-tasks to quit as tray Quit does (it writes pending changes first), waits
  for it, and ends it if it doesn't answer. True when it isn't running any more. }
function CloseApp: Boolean;
var
  Probe: HWND;
  Pid: Cardinal;
  Process: Longint;
  Waited: Integer;
begin
  Result := True;
  if not AppRunning then
    Exit;
  Log('desk-tasks is running: asking it to quit');
  Pid := 0;
  Probe := FindWindowByClassName(ProbeClass);
  if Probe <> 0 then
  begin
    GetWindowThreadProcessId(Probe, Pid);
    PostMessage(Probe, RegisterWindowMessage(QuitMessage), 0, 0);
  end;
  Waited := 0;
  while AppRunning and (Waited < QuitWaitMs) do
  begin
    Sleep(250);
    Waited := Waited + 250;
  end;
  if AppRunning and (Pid <> 0) then
  begin
    Log('desk-tasks did not quit in time: ending it');
    Process := OpenProcess(PROCESS_TERMINATE or SYNCHRONIZE, 0, Pid);
    if Process <> 0 then
    begin
      TerminateProcess(Process, 1);
      WaitForSingleObject(Process, 5000);
      CloseHandle(Process);
    end;
  end;
  Result := not AppRunning;
  if Result then
    Log('desk-tasks has quit');
end;

{ pythonw.exe of the newest version folder that has one (after a failed update: the old one). }
function InstalledExe: String;
var
  F: TFindRec;
  Best: String;
begin
  Result := '';
  Best := '';
  if FindFirst(ExpandConstant('{app}\app-*'), F) then
  try
    repeat
      if ((F.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0)
        and FileExists(ExpandConstant('{app}\') + F.Name + '\pythonw.exe')
        and (CompareText(F.Name, Best) > 0) then
        Best := F.Name;
    until not FindNext(F);
  finally
    FindClose(F);
  end;
  if Best <> '' then
    Result := ExpandConstant('{app}\') + Best + '\pythonw.exe';
end;

function WebView2At(Root: Integer): Boolean;
var
  V: String;
begin
  Result := RegQueryStringValue(Root, WebView2Client, 'pv', V) and (V <> '') and (V <> '0.0.0.0');
end;

{ Where Microsoft says to look: per machine (32-bit view) or per user. }
function HasWebView2: Boolean;
begin
  Result := WebView2At(HKLM32) or WebView2At(HKCU);
end;

function InitializeSetup: Boolean;
var
  Code: Integer;
begin
  Result := True;
  if not WizardSilent and not HasWebView2 then
    if MsgBox('desk-tasks needs the Microsoft Edge WebView2 Runtime, which isn''t on this PC yet.'
      + #13#10#13#10 + 'Open its download page? (Install desk-tasks either way; it works once '
      + 'WebView2 is there.)', mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://developer.microsoft.com/microsoft-edge/webview2/', '', '',
        SW_SHOWNORMAL, ewNoWait, Code);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not CloseApp then
    Result := 'desk-tasks is still running. Quit it from its tray icon, then try again.';
end;

procedure RemoveOldVersions;
var
  F: TFindRec;
begin
  if FindFirst(ExpandConstant('{app}\app-*'), F) then
  try
    repeat
      if ((F.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0)
        and (CompareText(F.Name, '{#AppDir}') <> 0) then
      begin
        Log('Removing the old version folder ' + F.Name);
        DelTree(ExpandConstant('{app}\') + F.Name, True, True, True);
      end;
    until not FindNext(F);
  finally
    FindClose(F);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    Installed := True;
    RemoveOldVersions;
  end;
end;

procedure DeinitializeSetup;
var
  Exe: String;
  Code: Integer;
begin
  if not IsRelaunch then
    Exit;
  { The new version, or after a failure the old one: desk-tasks never stays gone. }
  try
    if Installed then
      Exe := ExpandConstant('{#Exe}')
    else
      Exe := InstalledExe;
  except
    Exe := '';
  end;
  if Exe <> '' then
  begin
    Log('Starting ' + Exe);
    Exec(Exe, '-m desk_tasks --show', ExtractFileDir(Exe), SW_SHOWNORMAL, ewNoWait, Code);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Cmd, Exe: String;
  Code: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    CloseApp;
    ForgetData := not UninstallSilent and (MsgBox(
      'Also remove your desk-tasks settings from this PC?' + #13#10#13#10
      + 'This logs out (Nextcloud is asked to revoke the app password) and deletes the settings, '
      + 'logs and the local copy of your tasks. Your tasks in Nextcloud stay as they are.',
      mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES);
    Exe := InstalledExe;
    if ForgetData and (Exe <> '') then
      Exec(Exe, '-m desk_tasks --forget', ExtractFileDir(Exe), SW_HIDE, ewWaitUntilTerminated, Code);
  end;
  if CurUninstallStep = usPostUninstall then
  begin
    { Start with Windows, if it points here (a uv install of desk-tasks keeps its own). }
    if RegQueryStringValue(HKCU, RunKey, 'desk-tasks', Cmd)
      and (Pos(Lowercase(ExpandConstant('{app}')), Lowercase(Cmd)) > 0) then
      RegDeleteValue(HKCU, RunKey, 'desk-tasks');
    if ForgetData then
    begin
      RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Classes\AppUserModelId\DeskTasks');
      DelTree(ExpandConstant('{localappdata}\desk-tasks'), True, True, True);
    end;
  end;
end;
