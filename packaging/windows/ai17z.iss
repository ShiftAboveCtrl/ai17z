; AI17Z Windows installer.
;
; Inno Setup rather than MSIX, deliberately. AI17Z spawns the Google Chrome the
; owner already has, attaches to it over a loopback debug port, runs a
; long-lived local service, and writes browser profiles it must be able to find
; again. A packaged, sandboxed app is the wrong shape for that, and reshaping
; AI17Z to fit a package format would cost the thing that makes it work.
;
; Per-user rather than machine-wide, also deliberately:
;
;   - no administrator rights, so no UAC prompt on an installer that is
;     currently unsigned
;   - Chrome profiles belong to a user, not to a machine, and AI17Z's live under
;     the same account that owns the browser
;   - two people on one PC get their own AI17Z rather than fighting over one
;
; Data lives apart from the program, at {localappdata}\AI17Z. That separation is
; what makes an upgrade safe: the program directory is replaced, the data
; directory is never touched, and the uninstaller has to be asked before it
; removes it.

#define AppName "AI17Z"
#define AppPublisher "AI17Z"
#define AppUrl "https://github.com/ShiftAboveCtrl/ai17z"
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
; A release tag like v0.1.0-rc.1 is a perfectly good product version and an
; invalid VersionInfoVersion: Windows requires that field to be four numbers,
; and Inno refuses the whole script over it. That failure costs a one-second
; error at the end of an eight-minute build, and it only appears on the tags
; that matter -- 0.1.0 compiles, 0.1.0-rc.1 does not. So the numeric part is
; derived once, here, and the full string still reaches the file properties
; through the *TextVersion directives, which take free text.
#define NumericVersion Pos("-", AppVersion) > 0 ? Copy(AppVersion, 1, Pos("-", AppVersion) - 1) : AppVersion
; Where the staged application was assembled. Matches AI17Z_STAGE_DIR in
; tools/package-windows.mts, which exists because npm cannot create the
; workspace symlinks inside a folder OneDrive is syncing.
#ifndef StageDir
  #define StageDir "..\..\build\windows\app"
#endif

[Setup]
AppId={{8F3B2A41-6C7E-4E51-9C2B-AI17Z0000001}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
DefaultDirName={localappdata}\Programs\AI17Z
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\..\build\windows
OutputBaseFilename=AI17Z-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Per-user: no elevation, no UAC prompt.
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#AppName} {#AppVersion}
UninstallDisplayIcon={app}\packaging\windows\ai17z.ico
; SignPath requires signed binaries to carry product and version attributes,
; and they are what a person sees in the file properties either way.
VersionInfoVersion={#NumericVersion}
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#NumericVersion}
; What a person actually reads in the file properties, and what the release
; workflow checks: the version they downloaded, prerelease suffix and all.
VersionInfoTextVersion={#AppVersion}
VersionInfoProductTextVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} Setup
VersionInfoCopyright=MIT licensed
LicenseFile=..\..\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "ai17z.ico"; DestDir: "{app}\packaging\windows"; Flags: ignoreversion
Source: "AI17Z.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "Uninstall-Data.ps1"; DestDir: "{app}\packaging\windows"; Flags: ignoreversion
Source: "Stop-ForUninstall.ps1"; DestDir: "{app}\packaging\windows"; Flags: ignoreversion

[Icons]
Name: "{group}\AI17Z"; Filename: "{app}\AI17Z.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\packaging\windows\ai17z.ico"; Comment: "Start AI17Z and open it"
Name: "{group}\AI17Z diagnostics"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -NoExit -File ""{app}\doctor-ai17z.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\packaging\windows\ai17z.ico"; Comment: "Check what AI17Z needs and what is missing"
Name: "{group}\Stop AI17Z"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\stop-ai17z.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\packaging\windows\ai17z.ico"; Comment: "Stop AI17Z"
Name: "{autodesktop}\AI17Z"; Filename: "{app}\AI17Z.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\packaging\windows\ai17z.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\AI17Z.cmd"; Description: "Start AI17Z now"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
; Only what the installer itself created. Never the data directory: that is a
; separate, explicit choice, offered by the uninstaller below.
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\apps"
Type: filesandordirs; Name: "{app}\packages"

[Code]
const
  DataDirName = 'AI17Z';

var
  MissingPage: TOutputMsgMemoWizardPage;

function DataDir(): String;
begin
  Result := ExpandConstant('{localappdata}') + '\' + DataDirName;
end;

{ Whether a command resolves on PATH. Used to report what is missing rather
  than to install anything: silently putting three other products on somebody's
  machine is not a thing a setup program should do. }
function OnPath(Cmd: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec('cmd.exe', '/c where ' + Cmd + ' >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function ChromeInstalled(): Boolean;
begin
  Result := FileExists(ExpandConstant('{pf}\Google\Chrome\Application\chrome.exe'))
         or FileExists(ExpandConstant('{pf32}\Google\Chrome\Application\chrome.exe'))
         or FileExists(ExpandConstant('{localappdata}\Google\Chrome\Application\chrome.exe'));
end;

function MissingDependencies(): String;
var
  Missing: String;
begin
  Missing := '';
  if not OnPath('node') then
    Missing := Missing + '- Node.js 20 or newer' + #13#10 + '    https://nodejs.org/en/download' + #13#10#13#10;
  if not OnPath('docker') then
    Missing := Missing + '- Docker Desktop, which AI17Z uses to run PostgreSQL' + #13#10 + '    https://www.docker.com/products/docker-desktop/' + #13#10#13#10;
  if not ChromeInstalled() then
    Missing := Missing + '- Google Chrome. AI17Z drives the real Chrome, and no other' + #13#10 +
               '  browser is a substitute for it.' + #13#10 + '    https://www.google.com/chrome/' + #13#10#13#10;
  Result := Missing;
end;

procedure InitializeWizard();
begin
  MissingPage := CreateOutputMsgMemoPage(
    wpSelectTasks,
    'Before AI17Z can run',
    'AI17Z needs a few things that it will not install for you',
    'AI17Z does not install other software on your machine. If anything below is missing, ' +
    'install it and start AI17Z again. Setup will still finish either way.',
    '');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  { Nothing missing, nothing to say. }
  if (PageID = MissingPage.ID) and (MissingDependencies() = '') then
    Result := True;
end;

procedure CurPageChanged(CurPageID: Integer);
var
  Missing: String;
begin
  if CurPageID = MissingPage.ID then
  begin
    Missing := MissingDependencies();
    MissingPage.RichEditViewer.Text :=
      'Still needed:' + #13#10#13#10 + Missing +
      'AI17Z keeps your data in:' + #13#10 + '    ' + DataDir() + #13#10#13#10 +
      'That folder is left alone when you upgrade, and the uninstaller asks before removing it.';
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    { The data directory is created here rather than by the application, so an
      upgrade finds it already present and an uninstall has one place to ask
      about. Its contents are the owner's: profiles, storage, and the .env that
      holds the key their provider credentials are sealed with. }
    if not DirExists(DataDir()) then
      CreateDir(DataDir());
    if not DirExists(DataDir() + '\storage') then
      CreateDir(DataDir() + '\storage');
    if not DirExists(DataDir() + '\browser-profiles') then
      CreateDir(DataDir() + '\browser-profiles');
  end;
end;

{ Uninstall: the program always goes, the data only on request. }
function InitializeUninstall(): Boolean;
begin
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    { Stop first: removing files under a running worker leaves a half-deleted
      installation and a Chrome still holding a profile.

      A purpose-built script rather than stop-ai17z.ps1, because testing this
      found the general one can block. It is interactive in one branch and waits
      on Docker in others, and an uninstaller runs it with no console, so a
      prompt nobody can answer hangs forever. -NonInteractive makes any such
      prompt fail fast rather than wait, and the script itself is bounded. }
    Exec('powershell.exe',
      '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\packaging\windows\Stop-ForUninstall.ps1') + '"',
      ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;

  if CurUninstallStep = usPostUninstall then
  begin
    { Silent means nobody is there to answer. /SUPPRESSMSGBOXES suppresses
      Setup's own dialogs and not this one, so without this check a silent
      uninstall waits for ever on a prompt with no console -- which is exactly
      how it behaved before this line existed.

      Keeping the data is the right default for an unanswered question: it is
      the choice that can still be reversed afterwards. }
    if UninstallSilent() then
      Exit;

    if DirExists(DataDir()) then
    begin
      if MsgBox(
        'Remove AI17Z''s data as well?' + #13#10#13#10 +
        DataDir() + #13#10#13#10 +
        'This holds your agents, their memories and relationships, your knowledge sources, ' +
        'your saved browser sessions, and the key your provider credentials are encrypted with.' + #13#10#13#10 +
        'Choose No to keep all of it. Reinstalling AI17Z will pick up where you left off.' + #13#10#13#10 +
        'There is no undo.',
        mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      begin
        DelTree(DataDir(), True, True, True);
      end;
    end;
  end;
end;
