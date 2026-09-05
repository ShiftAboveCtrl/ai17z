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
; Fewer pages, and none of them decorative. Somebody installing this wants to
; know where it goes, what it will use, and what it needs -- not to click Next
; four times past screens that say nothing.
DisableWelcomePage=no
DisableReadyPage=no
ShowLanguageDialog=no
WizardSizePercent=110
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
; On by default. It is the way most people will open this.
Name: "desktopicon"; Description: "Create a shortcut on my desktop"; GroupDescription: "Shortcuts:"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "ai17z.ico"; DestDir: "{app}\packaging\windows"; Flags: ignoreversion
Source: "AI17Z.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "Uninstall-Data.ps1"; DestDir: "{app}\packaging\windows"; Flags: ignoreversion
Source: "Stop-ForUninstall.ps1"; DestDir: "{app}\packaging\windows"; Flags: ignoreversion
Source: "Install-Prerequisites.ps1"; DestDir: "{app}\packaging\windows"; Flags: ignoreversion

[Icons]
Name: "{group}\AI17Z"; Filename: "{app}\AI17Z.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\packaging\windows\ai17z.ico"; Comment: "Start AI17Z and open it"
Name: "{group}\AI17Z diagnostics"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -NoExit -File ""{app}\doctor-ai17z.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\packaging\windows\ai17z.ico"; Comment: "Check what AI17Z needs and what is missing"
Name: "{group}\Stop AI17Z"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\stop-ai17z.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\packaging\windows\ai17z.ico"; Comment: "Stop AI17Z"
Name: "{group}\Install what AI17Z needs"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\packaging\windows\Install-Prerequisites.ps1"" -Pause"; WorkingDir: "{app}"; IconFilename: "{app}\packaging\windows\ai17z.ico"; Comment: "Check for Node.js, Docker Desktop and Chrome, and install any that are missing"
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
{ ---------------------------------------------------------------------------
  The wizard.

  Three questions, in the order somebody would ask them:

    1. Where does my data go?   (separate from the program, and movable)
    2. Which ports may it use?  (in case 8080 is already something else)
    3. What does it still need? (and shall I fetch it for you)

  Every page says what will happen and what will not. An installer that is
  vague about what it touches is one people are right to be nervous about, and
  this one runs a local service, opens a browser and holds their credentials.
  --------------------------------------------------------------------------- }

const
  DefaultWebPort = '8080';
  DefaultApiPort = '8787';
  DefaultDbPort  = '55432';

var
  DataPage:    TInputDirWizardPage;
  PortsPage:   TInputQueryWizardPage;
  NeedsPage:   TWizardPage;
  NeedsNode:   TCheckBox;
  NeedsDocker: TCheckBox;
  NeedsChrome: TCheckBox;
  NeedsIntro:  TNewStaticText;
  NeedsFooter: TNewStaticText;

{ Where the owner's data lives. Read back on later runs so an upgrade offers
  the folder already in use rather than silently proposing a new one. }
function DataDir(): String;
begin
  if (DataPage <> nil) and (DataPage.Values[0] <> '') then
    Result := DataPage.Values[0]
  else
    Result := ExpandConstant('{localappdata}') + '\AI17Z';
end;

function PreviousDataDir(): String;
var
  Stored: String;
begin
  Result := '';
  if RegQueryStringValue(HKCU, 'Software\AI17Z', 'DataDir', Stored) and (Stored <> '') then
    Result := Stored;
end;

{ ---------------------------------------------------------------------------
  What is already here
  --------------------------------------------------------------------------- }

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

function DockerInstalled(): Boolean;
begin
  Result := OnPath('docker') or FileExists(ExpandConstant('{pf}\Docker\Docker\Docker Desktop.exe'));
end;

function NodeInstalled(): Boolean;
begin
  Result := OnPath('node');
end;

function WingetAvailable(): Boolean;
begin
  Result := OnPath('winget');
end;

function AnythingMissing(): Boolean;
begin
  Result := (not NodeInstalled()) or (not DockerInstalled()) or (not ChromeInstalled());
end;

{ ---------------------------------------------------------------------------
  Ports
  --------------------------------------------------------------------------- }

function IsPortNumber(Value: String): Boolean;
var
  N: Integer;
begin
  Result := False;
  if Value = '' then Exit;
  N := StrToIntDef(Value, -1);
  { Below 1024 needs privileges this installer deliberately does not have. }
  Result := (N >= 1024) and (N <= 65535);
end;

{ Whether something is already listening. Reported rather than enforced: a port
  can be free now and taken by the time AI17Z starts, and refusing to continue
  over a guess would be worse than saying so. }
function PortInUse(Port: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec('cmd.exe', '/c netstat -an | findstr /R /C:":' + Port + ' .*LISTENING" >nul 2>&1',
                 '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function PortsProblem(): String;
var
  Web, Api, Db: String;
  Taken: String;
begin
  Result := '';
  Web := Trim(PortsPage.Values[0]);
  Api := Trim(PortsPage.Values[1]);
  Db  := Trim(PortsPage.Values[2]);

  if not IsPortNumber(Web) then Result := 'The web port must be a number between 1024 and 65535.'
  else if not IsPortNumber(Api) then Result := 'The API port must be a number between 1024 and 65535.'
  else if not IsPortNumber(Db) then Result := 'The database port must be a number between 1024 and 65535.'
  else if (Web = Api) or (Web = Db) or (Api = Db) then Result := 'The three ports have to be different from each other.';

  if Result <> '' then Exit;

  { A warning, not a refusal. }
  Taken := '';
  if PortInUse(Web) then Taken := Taken + '  ' + Web + ' (web)' + #13#10;
  if PortInUse(Api) then Taken := Taken + '  ' + Api + ' (API)' + #13#10;
  if PortInUse(Db)  then Taken := Taken + '  ' + Db  + ' (database)' + #13#10;
  if Taken <> '' then
  begin
    if MsgBox('Something is already listening on:' + #13#10#13#10 + Taken + #13#10 +
              'AI17Z will fail to start on a port another program is using.' + #13#10#13#10 +
              'Use these ports anyway?', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDNO then
      Result := 'Choose different ports.';
  end;
end;

{ ---------------------------------------------------------------------------
  Pages
  --------------------------------------------------------------------------- }

procedure InitializeWizard();
var
  Previous: String;
  Y: Integer;
begin
  { 1. Data directory. }
  DataPage := CreateInputDirPage(wpSelectDir,
    'Where should AI17Z keep your data?',
    'Your agents, their memories, your saved sign-ins and your encryption key',
    'This is separate from the program folder on purpose. Upgrading AI17Z replaces the program' + #13#10 +
    'and never touches this folder, and the uninstaller asks before removing it.' + #13#10#13#10 +
    'Put it on another drive if you would rather it was not on your system disk.',
    False, '');
  DataPage.Add('');

  Previous := PreviousDataDir();
  if Previous <> '' then
    DataPage.Values[0] := Previous
  else
    DataPage.Values[0] := ExpandConstant('{localappdata}') + '\AI17Z';

  { 2. Ports. }
  PortsPage := CreateInputQueryPage(DataPage.ID,
    'Which ports may AI17Z use?',
    'Only on this machine. Nothing is opened to the internet',
    'AI17Z runs a small web application and a database on your own computer. These are the' + #13#10 +
    'ports it listens on, and they are reachable only from this machine.' + #13#10#13#10 +
    'Change them if something else on your PC already uses one.');
  PortsPage.Add('AI17Z in your browser', False);
  PortsPage.Add('Its internal API', False);
  PortsPage.Add('Its PostgreSQL database', False);
  PortsPage.Values[0] := DefaultWebPort;
  PortsPage.Values[1] := DefaultApiPort;
  PortsPage.Values[2] := DefaultDbPort;

  { 3. What is missing, and an offer to fetch it. }
  NeedsPage := CreateCustomPage(PortsPage.ID,
    'AI17Z needs three other programs',
    'It can install them for you, or you can do it yourself');

  NeedsIntro := TNewStaticText.Create(WizardForm);
  NeedsIntro.Parent := NeedsPage.Surface;
  NeedsIntro.Left := 0;
  NeedsIntro.Top := 0;
  NeedsIntro.Width := NeedsPage.SurfaceWidth;
  NeedsIntro.WordWrap := True;
  NeedsIntro.AutoSize := True;
  NeedsIntro.Caption :=
    'Tick anything you would like installed. Each one comes from its own maker, through' + #13#10 +
    'winget, which is Microsoft''s package manager and is already part of Windows.' + #13#10 +
    'It checks each installer before running it. AI17Z never downloads programs itself.' + #13#10#13#10 +
    'Leave them unticked and nothing is installed; AI17Z will tell you what is missing when' + #13#10 +
    'you start it. You can also do this later from the Start Menu.';

  Y := NeedsIntro.Top + NeedsIntro.Height + ScaleY(14);

  NeedsNode := TCheckBox.Create(WizardForm);
  NeedsNode.Parent := NeedsPage.Surface;
  NeedsNode.Left := 0;
  NeedsNode.Top := Y;
  NeedsNode.Width := NeedsPage.SurfaceWidth;
  NeedsNode.Caption := 'Node.js  -  runs AI17Z itself';

  NeedsDocker := TCheckBox.Create(WizardForm);
  NeedsDocker.Parent := NeedsPage.Surface;
  NeedsDocker.Left := 0;
  NeedsDocker.Top := Y + ScaleY(24);
  NeedsDocker.Width := NeedsPage.SurfaceWidth;
  NeedsDocker.Caption := 'Docker Desktop  -  runs the database your agents live in';

  NeedsChrome := TCheckBox.Create(WizardForm);
  NeedsChrome.Parent := NeedsPage.Surface;
  NeedsChrome.Left := 0;
  NeedsChrome.Top := Y + ScaleY(48);
  NeedsChrome.Width := NeedsPage.SurfaceWidth;
  NeedsChrome.Caption := 'Google Chrome  -  the browser your agent acts through';

  NeedsFooter := TNewStaticText.Create(WizardForm);
  NeedsFooter.Parent := NeedsPage.Surface;
  NeedsFooter.Left := 0;
  NeedsFooter.Top := Y + ScaleY(80);
  NeedsFooter.Width := NeedsPage.SurfaceWidth;
  NeedsFooter.WordWrap := True;
  NeedsFooter.AutoSize := True;
end;

{ Only show the dependency page when something is actually missing, and only
  tick what is missing. An installer that offers to reinstall Chrome you
  already have is one nobody trusts a second time. }
procedure PrepareNeedsPage();
var
  Footer: String;
begin
  NeedsNode.Enabled := not NodeInstalled();
  NeedsDocker.Enabled := not DockerInstalled();
  NeedsChrome.Enabled := not ChromeInstalled();

  NeedsNode.Checked := NeedsNode.Enabled;
  NeedsDocker.Checked := NeedsDocker.Enabled;
  NeedsChrome.Checked := NeedsChrome.Enabled;

  if not NeedsNode.Enabled then NeedsNode.Caption := 'Node.js  -  already installed';
  if not NeedsDocker.Enabled then NeedsDocker.Caption := 'Docker Desktop  -  already installed';
  if not NeedsChrome.Enabled then NeedsChrome.Caption := 'Google Chrome  -  already installed';

  if WingetAvailable() then
    Footer := 'Windows will ask your permission before anything is installed. Docker Desktop' + #13#10 +
              'may ask you to restart afterwards.'
  else
    Footer := 'winget is not available on this PC, so AI17Z cannot install these for you.' + #13#10 +
              'Ticking a box will open that program''s own download page instead.';

  NeedsFooter.Caption := Footer;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if (PageID = NeedsPage.ID) and (not AnythingMissing()) then
    Result := True;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = NeedsPage.ID then
    PrepareNeedsPage();
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Problem: String;
begin
  Result := True;
  if CurPageID = PortsPage.ID then
  begin
    Problem := PortsProblem();
    if Problem <> '' then
    begin
      MsgBox(Problem, mbError, MB_OK);
      Result := False;
    end;
  end;
end;

{ What the Ready page lists, so the last screen before anything happens is an
  honest summary rather than "click Install". }
function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo,
  MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
var
  S: String;
  Wanted: String;
begin
  S := MemoDirInfo + NewLine + NewLine;
  S := S + 'Your data:' + NewLine + Space + DataDir() + NewLine + NewLine;
  S := S + 'Ports on this machine only:' + NewLine;
  S := S + Space + PortsPage.Values[0] + '  AI17Z in your browser' + NewLine;
  S := S + Space + PortsPage.Values[1] + '  its internal API' + NewLine;
  S := S + Space + PortsPage.Values[2] + '  its database' + NewLine + NewLine;

  Wanted := '';
  if (NeedsNode <> nil) and NeedsNode.Enabled and NeedsNode.Checked then Wanted := Wanted + Space + 'Node.js' + NewLine;
  if (NeedsDocker <> nil) and NeedsDocker.Enabled and NeedsDocker.Checked then Wanted := Wanted + Space + 'Docker Desktop' + NewLine;
  if (NeedsChrome <> nil) and NeedsChrome.Enabled and NeedsChrome.Checked then Wanted := Wanted + Space + 'Google Chrome' + NewLine;

  if Wanted <> '' then
    S := S + 'Will also install, through winget:' + NewLine + Wanted + NewLine
  else
    S := S + 'No other programs will be installed.' + NewLine + NewLine;

  if MemoTasksInfo <> '' then
    S := S + MemoTasksInfo + NewLine;

  Result := S;
end;

{ ---------------------------------------------------------------------------
  Doing it
  --------------------------------------------------------------------------- }

{ The chosen settings, written where the launcher and the app both read them.

  Into the data directory's .env rather than the program directory, because the
  program directory is replaced on every upgrade and these are the owner's
  choices, not the build's. Existing values are left alone: somebody who edited
  their .env by hand did so on purpose. }
procedure WriteSettings();
var
  EnvPath: String;
  Lines: TArrayOfString;
  I: Integer;
  HasWeb, HasApi, HasDb: Boolean;
begin
  EnvPath := DataDir() + '\.env';
  HasWeb := False; HasApi := False; HasDb := False;

  if FileExists(EnvPath) and LoadStringsFromFile(EnvPath, Lines) then
  begin
    for I := 0 to GetArrayLength(Lines) - 1 do
    begin
      if Pos('AI17Z_WEB_PORT=', Lines[I]) = 1 then HasWeb := True;
      if Pos('AI17Z_API_PORT=', Lines[I]) = 1 then HasApi := True;
      if Pos('POSTGRES_PORT=', Lines[I]) = 1 then HasDb := True;
    end;
  end;

  if not HasWeb then SaveStringToFile(EnvPath, 'AI17Z_WEB_PORT=' + Trim(PortsPage.Values[0]) + #13#10, True);
  if not HasApi then SaveStringToFile(EnvPath, 'AI17Z_API_PORT=' + Trim(PortsPage.Values[1]) + #13#10, True);
  if not HasDb  then SaveStringToFile(EnvPath, 'POSTGRES_PORT=' + Trim(PortsPage.Values[2]) + #13#10, True);

  { The launcher reads this to find the data directory, which is why it is a
    file next to the program rather than a value baked into the .cmd. }
  SaveStringToFile(ExpandConstant('{app}') + '\data-location.txt', DataDir(), False);

  { And the registry, so the next installer offers the same folder. }
  RegWriteStringValue(HKCU, 'Software\AI17Z', 'DataDir', DataDir());
end;

procedure InstallPrerequisites();
var
  Wanted: String;
  ResultCode: Integer;
begin
  Wanted := '';
  if NeedsNode.Enabled and NeedsNode.Checked then Wanted := Wanted + 'node,';
  if NeedsDocker.Enabled and NeedsDocker.Checked then Wanted := Wanted + 'docker,';
  if NeedsChrome.Enabled and NeedsChrome.Checked then Wanted := Wanted + 'chrome,';
  if Wanted = '' then Exit;

  WizardForm.StatusLabel.Caption := 'Installing what AI17Z needs. Windows may ask your permission.';

  { Visible, not hidden. Somebody who agreed to have three programs installed
    should be able to watch it happen, and a silent window here would be the
    single most alarming thing this installer could do.

    Elevated, because Docker Desktop cannot install without it. The UAC prompt
    is the consent, and it names PowerShell rather than pretending otherwise. }
  ShellExec('runas', 'powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\packaging\windows\Install-Prerequisites.ps1') + '" -Install "' + Wanted + '"',
    ExpandConstant('{app}'), SW_SHOW, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    { Created here rather than by the application, so an upgrade finds it
      already present and an uninstall has one place to ask about. }
    if not DirExists(DataDir()) then
      CreateDir(DataDir());
    if not DirExists(DataDir() + '\storage') then
      CreateDir(DataDir() + '\storage');
    if not DirExists(DataDir() + '\browser-profiles') then
      CreateDir(DataDir() + '\browser-profiles');

    WriteSettings();
    InstallPrerequisites();
  end;
end;

{ ---------------------------------------------------------------------------
  Uninstall: the program always goes, the data only on request
  --------------------------------------------------------------------------- }

function UninstallDataDir(): String;
var
  Stored: String;
begin
  { Where it actually went, not where it would have gone by default. Somebody
    who moved their data to another drive must not have the default folder
    offered for deletion instead. }
  Result := ExpandConstant('{localappdata}') + '\AI17Z';
  if RegQueryStringValue(HKCU, 'Software\AI17Z', 'DataDir', Stored) and (Stored <> '') then
    Result := Stored;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
  Dir: String;
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

    Dir := UninstallDataDir();
    if DirExists(Dir) then
    begin
      if MsgBox(
        'Remove AI17Z''s data as well?' + #13#10#13#10 +
        Dir + #13#10#13#10 +
        'This holds your agents, their memories and relationships, your knowledge sources, ' +
        'your saved browser sessions, and the key your provider credentials are encrypted with.' + #13#10#13#10 +
        'Choose No to keep all of it. Reinstalling AI17Z will pick up where you left off.' + #13#10#13#10 +
        'There is no undo.',
        mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      begin
        DelTree(Dir, True, True, True);
        RegDeleteKeyIncludingSubkeys(HKCU, 'Software\AI17Z');
      end;
    end;
  end;
end;
