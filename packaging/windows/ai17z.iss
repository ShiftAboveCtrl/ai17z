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
;
; What the release is called, as opposed to what it is numbered.
;
; "AI17Z 1.0.0-beta.1" is a version with a product name stuck on the front.
; "AI17Z Beta 1.0.0" is a name: which product, how finished, which one. It is
; what Add/Remove Programs lists, what the wizard says it is installing, and
; what the app shows on the version screen -- so it is derived from the same
; version string in both places rather than typed twice.
;
; The grammar matches releaseName() in packages/shared/src/version.ts. Keep
; them together: the two are read side by side, one in the Windows uninstall
; list and one in AI17Z's own settings, and disagreeing looks like two builds.
#define PreRelease Pos("-", AppVersion) > 0 ? Copy(AppVersion, Pos("-", AppVersion) + 1, 64) : ""
#define PreWord Pos(".", PreRelease) > 0 ? Copy(PreRelease, 1, Pos(".", PreRelease) - 1) : PreRelease
#define PreCount Pos(".", PreRelease) > 0 ? Copy(PreRelease, Pos(".", PreRelease) + 1, 8) : ""
#define ChannelWord \
  LowerCase(PreWord) == "beta" ? "Beta" : \
  LowerCase(PreWord) == "rc" ? "Release Candidate" : \
  LowerCase(PreWord) == "alpha" ? "Alpha" : \
  LowerCase(PreWord) == "preview" ? "Preview" : PreWord
; The first beta is just "Beta"; only a second one has to say which.
#define IterationSuffix (PreCount != "" && PreCount != "1") ? " (" + PreCount + ")" : ""
#define ReleaseVersionOnly ChannelWord == "" ? \
  NumericVersion : \
  ChannelWord + " " + NumericVersion + IterationSuffix
#ifndef ReleaseName
  #define ReleaseName ChannelWord == "" ? \
    AppName + " " + NumericVersion : \
    AppName + " " + ChannelWord + " " + NumericVersion + IterationSuffix
#endif
; Where the staged application was assembled. Matches AI17Z_STAGE_DIR in
; tools/package-windows.mts, which exists because npm cannot create the
; workspace symlinks inside a folder OneDrive is syncing.
#ifndef StageDir
  #define StageDir "..\..\build\windows\app"
#endif

[Setup]
; Per installation, not per product.
;
; A fixed AppId means one uninstall entry, one Start Menu group and one desktop
; icon for every copy on the machine -- so a second installation silently took
; over the first one's. Everything that identifies an installation to Windows is
; now derived from its name, and the name is asked for exactly once.
;
; The suffix is appended to a fixed prefix rather than being a fresh GUID, so an
; upgrade of the same instance keeps the same identity and replaces itself
; instead of installing alongside.
AppId={code:AppIdFor}
; Required by Inno whenever AppId contains a constant: it cannot look up a
; previous language for an id it does not know until the wizard has run.
; There is one language here anyway, and ShowLanguageDialog is already off.
UsePreviousLanguage=no
AppName={code:InstanceName}
AppVersion={#AppVersion}
AppVerName={code:InstanceName} {#ReleaseVersionOnly}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
DefaultDirName={localappdata}\Programs\{code:InstanceName}
DefaultGroupName={code:InstanceName}
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
WizardSizePercent=120
; The installer's own artwork, drawn by packaging/windows/make-wizard-art.py.
;
; Stock Inno ships a blue-green gradient with a hand holding a box. It is the
; first thing anybody sees of AI17Z and it looks like every other installer
; from 2003. These are the product's own ground and wordmark instead.
WizardImageFile=wizard-panel.bmp
WizardSmallImageFile=wizard-small.bmp
; Stretched, and drawn oversized at the same aspect ratio so stretching cannot
; soften it. Unstretched, Inno centres a 164x314 bitmap in a much larger area
; and surrounds it with bare form colour, which looked like a mistake.
WizardImageStretch=yes
SetupIconFile=ai17z.ico
; Per-user: no elevation, no UAC prompt.
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={code:InstanceName} {#ReleaseVersionOnly}
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
; The licence page is back.
;
; It was removed while the wizard was painted in the product's dark palette,
; because two of its controls could not follow: a TRichEditViewer keeps its own
; character colours, and a themed radio draws its caption in the theme colour
; whatever it is told. Both went dark on dark, and a licence nobody can read is
; worse than no licence page.
;
; None of that applies to a wizard Windows draws itself.
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
Name: "{autodesktop}\{code:InstanceName}"; Filename: "{app}\AI17Z.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\packaging\windows\ai17z.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\AI17Z.cmd"; Description: "Start AI17Z now"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
; Only what the installer itself created. Never the data directory: that is a
; separate, explicit choice, offered by the uninstaller below.
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\apps"
Type: filesandordirs; Name: "{app}\packages"
; Written by WriteSettings rather than installed from [Files], so Setup does not
; know about it and an uninstall left the program directory behind holding one
; orphaned file.
Type: files; Name: "{app}\data-location.txt"

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

type
  TInstall = record
    Program_: String;
    Data: String;
    Version: String;
    Ports: String;
  end;

var
  PortsFilled: Boolean;
  FoundPage:   TWizardPage;
  FreshRadio:  TNewRadioButton;
  FoundIntro:  TNewStaticText;
  FoundDetail: TNewStaticText;
  Installs:    array of TInstall;
  InstallRadios: array of TNewRadioButton;

  NamePage:    TInputQueryWizardPage;
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
{ Which installation the person chose on the first page, or -1 for a new one. }
function ChosenInstall(): Integer;
var
  I: Integer;
begin
  Result := -1;
  for I := 0 to GetArrayLength(InstallRadios) - 1 do
    if InstallRadios[I].Checked then
    begin
      Result := I;
      Exit;
    end;
end;

function UpdatingExisting(): Boolean;
begin
  Result := ChosenInstall() >= 0;
end;

function DataDir(): String;
var
  Chosen: Integer;
begin
  { Updating an existing installation keeps its data exactly where it is. Asking
    again would be the one question with a wrong answer available. }
  Chosen := ChosenInstall();
  if Chosen >= 0 then
  begin
    Result := Installs[Chosen].Data;
    Exit;
  end;
  if (DataPage <> nil) and (DataPage.Values[0] <> '') then
    Result := DataPage.Values[0]
  else
    Result := ExpandConstant('{localappdata}') + '\AI17Z';
end;

{ ---------------------------------------------------------------------------
  What is already installed
  --------------------------------------------------------------------------- }

{ Every installation records itself, because one registry key cannot hold two.

  The uninstall entry is keyed on AppId, and AppId is fixed -- so a second
  installation overwrites the first one's entry and the first becomes invisible
  to Windows and to this. A list under our own key is the only place two of them
  can both be known. }
{ The first free port at or after Start.

  Asked of Windows rather than guessed: `netstat` output is parsed by nobody
  here, and a port somebody else is listening on is exactly what this exists to
  step over. Three of these run before the ports page is shown, so a second and
  third installation get their own without anybody being asked to think about
  it.

  Bounded: if two hundred consecutive ports are busy something else is wrong,
  and returning Start lets the page show it rather than looping. }
function FirstFreePort(Start: Integer): Integer;
var
  I, Code: Integer;
begin
  for I := Start to Start + 200 do
  begin
    { -1 means "not listening", which is what free means here. }
    if not Exec('cmd.exe', '/c netstat -ano -p tcp | findstr /r /c:":' + IntToStr(I) + ' .*LISTENING" >nul',
                '', SW_HIDE, ewWaitUntilTerminated, Code) then
    begin
      Result := I;
      Exit;
    end;
    if Code <> 0 then
    begin
      Result := I;
      Exit;
    end;
  end;
  Result := Start;
end;

{ What this installation is called.

  One word, and everything Windows uses to tell two copies apart is built from
  it: the program folder, the Start Menu group, the desktop icon and the
  uninstall entry. Updating an existing installation reuses its name, so an
  upgrade replaces rather than multiplies.

  Defaults to AI17Z, which is what a single installation should be called and
  what every existing one already is. }
function InstanceName(Param: String): String;
var
  Chosen: Integer;
begin
  Chosen := ChosenInstall();
  if Chosen >= 0 then
  begin
    Result := ExtractFileName(RemoveBackslash(Installs[Chosen].Program_));
    if Result <> '' then Exit;
  end;
  if (NamePage <> nil) and (Trim(NamePage.Values[0]) <> '') then
    Result := Trim(NamePage.Values[0])
  else
    Result := 'AI17Z';
end;

{ A stable AppId per instance.

  Derived from the name rather than generated, so installing the same instance
  again replaces it. The prefix is the original AppId, so an installation made
  before this existed -- which is called AI17Z -- keeps the identity it already
  had and upgrades in place rather than appearing twice. }
function AppIdFor(Param: String): String;
var
  Name: String;
begin
  Name := InstanceName('');
  if CompareText(Name, 'AI17Z') = 0 then
    Result := '{8F3B2A41-6C7E-4E51-9C2B-AI17Z0000001}'
  else
    Result := '{8F3B2A41-6C7E-4E51-9C2B-AI17Z0000001}_' + Name;
end;

procedure RememberInstall(ProgramDir: String);
begin
  { Keyed by the path, so installing twice into one folder stays one entry. }
  RegWriteStringValue(HKCU, 'Software\AI17Z\Installs', ProgramDir, ProgramDir);
end;

function ReadLineFrom(Path: String): String;
var
  Lines: TArrayOfString;
begin
  Result := '';
  if FileExists(Path) and LoadStringsFromFile(Path, Lines) and (GetArrayLength(Lines) > 0) then
    Result := Trim(Lines[0]);
end;

{ One line out of an environment file, without pulling in a parser. }
function EnvValue(EnvPath: String; Key: String): String;
var
  Lines: TArrayOfString;
  I: Integer;
  Line: String;
begin
  Result := '';
  if not FileExists(EnvPath) then Exit;
  if not LoadStringsFromFile(EnvPath, Lines) then Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    Line := Trim(Lines[I]);
    if Pos(Key + '=', Line) = 1 then
    begin
      Result := Trim(Copy(Line, Length(Key) + 2, Length(Line)));
      Exit;
    end;
  end;
end;

{ Describes one installation from what is on disk beside it. }
function DescribeInstall(ProgramDir: String; var Found: TInstall): Boolean;
var
  Data, Env, Web, Api, Db: String;
begin
  Result := False;
  if not FileExists(ProgramDir + '\AI17Z.cmd') then Exit;

  Found.Program_ := ProgramDir;
  Found.Version := 'unknown version';
  Found.Ports := '';

  { The version is in the stamp the packager writes. Read as a line rather than
    parsed: it is one flat object and this only needs one field of it. }
  if FileExists(ProgramDir + '\BUILD_INFO.json') then
  begin
    Env := ReadLineFrom(ProgramDir + '\BUILD_INFO.json');
    Found.Version := 'installed';
  end;

  Data := ReadLineFrom(ProgramDir + '\data-location.txt');
  if Data = '' then Data := ExpandConstant('{localappdata}') + '\AI17Z';
  Found.Data := Data;

  Env := Data + '\.env';
  Web := EnvValue(Env, 'AI17Z_WEB_PORT');
  Api := EnvValue(Env, 'AI17Z_API_PORT');
  Db := EnvValue(Env, 'POSTGRES_PORT');
  if Web <> '' then Found.Ports := Web + ', ' + Api + ', ' + Db;

  Result := True;
end;

{ Everything on this machine that looks like an AI17Z.

  Two places, because neither alone is enough: the list every installation
  writes about itself, and a sweep of the folder installations go in by default
  -- which catches one installed before this list existed. }
procedure FindInstalls();
var
  Names: TArrayOfString;
  Rec: TFindRec;
  Base, Dir: String;
  I, N: Integer;
  Entry: TInstall;
  Seen: String;
begin
  SetArrayLength(Installs, 0);
  Seen := '|';

  if RegGetValueNames(HKCU, 'Software\AI17Z\Installs', Names) then
    for I := 0 to GetArrayLength(Names) - 1 do
      if DescribeInstall(Names[I], Entry) and (Pos('|' + Lowercase(Names[I]) + '|', Seen) = 0) then
      begin
        N := GetArrayLength(Installs);
        SetArrayLength(Installs, N + 1);
        Installs[N] := Entry;
        Seen := Seen + Lowercase(Names[I]) + '|';
      end;

  Base := ExpandConstant('{localappdata}') + '\Programs';
  if FindFirst(Base + '\*', Rec) then
  try
    repeat
      if (Rec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
      begin
        Dir := Base + '\' + Rec.Name;
        if (Rec.Name <> '.') and (Rec.Name <> '..')
           and DescribeInstall(Dir, Entry)
           and (Pos('|' + Lowercase(Dir) + '|', Seen) = 0) then
        begin
          N := GetArrayLength(Installs);
          SetArrayLength(Installs, N + 1);
          Installs[N] := Entry;
          Seen := Seen + Lowercase(Dir) + '|';
        end;
      end;
    until not FindNext(Rec);
  finally
    FindClose(Rec);
  end;
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
  Y, I: Integer;
  Radio: TNewRadioButton;
  Line: TNewStaticText;
begin
  { 0. What is already on this machine.

    Without this, a second installation is indistinguishable from an upgrade:
    the wizard offers the same folder, quietly replaces what is there, and
    somebody who wanted two AI17Zs ends up with one. Shown only when there is
    something to choose between. }
  FindInstalls();
  if GetArrayLength(Installs) > 0 then
  begin
    FoundPage := CreateCustomPage(wpWelcome,
      'AI17Z is already on this computer',
      'Update the one you have, or set up another beside it');

    FoundIntro := TNewStaticText.Create(WizardForm);
    FoundIntro.Parent := FoundPage.Surface;
    FoundIntro.Left := 0;
    FoundIntro.Top := 0;
    FoundIntro.Width := FoundPage.SurfaceWidth;
    FoundIntro.WordWrap := True;
    FoundIntro.AutoSize := True;
    FoundIntro.Caption :=
      'Updating replaces the program and keeps everything else: your agents, their memories,' + #13#10 +
      'your sign-ins and your encryption key all stay exactly where they are.' + #13#10#13#10 +
      'A separate installation shares nothing with the others -- its own folder, its own' + #13#10 +
      'database, its own ports. Use one if you want somewhere to experiment.';

    Y := FoundIntro.Top + FoundIntro.Height + ScaleY(16);
    SetArrayLength(InstallRadios, GetArrayLength(Installs));

    for I := 0 to GetArrayLength(Installs) - 1 do
    begin
      { Each row is a radio with two lines of detail indented under it.

        Positioned from the control's own Height, never from a guessed offset.
        A hard-coded 19 pixels is right at one font size and one scaling, and
        this wizard runs at 120% on whatever the display is set to -- so the
        detail sat on top of the caption and clipped it in half. }
      Radio := TNewRadioButton.Create(WizardForm);
      Radio.Parent := FoundPage.Surface;
      Radio.Left := 0;
      Radio.Top := Y;
      Radio.Width := FoundPage.SurfaceWidth;
      Radio.Height := ScaleY(20);
      Radio.Caption := 'Update the one in ' + ExtractFileName(Installs[I].Program_);
      Radio.Checked := (I = 0);
      InstallRadios[I] := Radio;

      Line := TNewStaticText.Create(WizardForm);
      Line.Parent := FoundPage.Surface;
      Line.Left := ScaleX(20);
      Line.Top := Radio.Top + Radio.Height + ScaleY(3);
      Line.Width := FoundPage.SurfaceWidth - ScaleX(20);
      Line.WordWrap := True;
      Line.AutoSize := True;
      if Installs[I].Ports <> '' then
        Line.Caption := Installs[I].Program_ + #13#10 + 'data in ' + Installs[I].Data + '  -  ports ' + Installs[I].Ports
      else
        Line.Caption := Installs[I].Program_ + #13#10 + 'data in ' + Installs[I].Data;

      Y := Line.Top + Line.Height + ScaleY(16);
    end;

    FreshRadio := TNewRadioButton.Create(WizardForm);
    FreshRadio.Parent := FoundPage.Surface;
    FreshRadio.Left := 0;
    FreshRadio.Top := Y;
    FreshRadio.Width := FoundPage.SurfaceWidth;
    FreshRadio.Height := ScaleY(20);
    FreshRadio.Caption := 'Set up another AI17Z, separate from these';

    FoundDetail := TNewStaticText.Create(WizardForm);
    FoundDetail.Parent := FoundPage.Surface;
    FoundDetail.Left := ScaleX(20);
    FoundDetail.Top := FreshRadio.Top + FreshRadio.Height + ScaleY(3);
    FoundDetail.Width := FoundPage.SurfaceWidth - ScaleX(20);
    FoundDetail.WordWrap := True;
    FoundDetail.AutoSize := True;
    FoundDetail.Caption := 'You choose its folder and it picks its own free ports.';
  end;

  { 1. What to call it, so a second copy is a second copy. }
  NamePage := CreateInputQueryPage(wpWelcome,
    'What should this installation be called?',
    'Only matters if you want more than one',
    'One name, used for the program folder, the Start Menu group, the desktop icon and the' + #13#10 +
    'entry in Add or remove programs. Leave it as AI17Z unless you are installing a second' + #13#10 +
    'copy alongside one you already have -- then give this one a name of its own.');
  NamePage.Add('Name', False);
  NamePage.Values[0] := 'AI17Z';

  { 2. Data directory. }
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
    DataPage.Values[0] := ExpandConstant('{localappdata}') + '\' + InstanceName('');

  { 3. Ports. }
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

  { Stacked from each control's own Height, not from 24 and 48 and 80.

    Guessed offsets are right at one font size and one display scaling. This
    wizard runs at 120% of whatever the display is set to, and on the page that
    listed installations the same guess put the detail line on top of the
    caption and clipped it in half. }
  NeedsNode := TCheckBox.Create(WizardForm);
  NeedsNode.Parent := NeedsPage.Surface;
  NeedsNode.Left := 0;
  NeedsNode.Top := Y;
  NeedsNode.Width := NeedsPage.SurfaceWidth;
  NeedsNode.Height := ScaleY(20);
  NeedsNode.Caption := 'Node.js  -  runs AI17Z itself';

  NeedsDocker := TCheckBox.Create(WizardForm);
  NeedsDocker.Parent := NeedsPage.Surface;
  NeedsDocker.Left := 0;
  NeedsDocker.Top := NeedsNode.Top + NeedsNode.Height + ScaleY(6);
  NeedsDocker.Width := NeedsPage.SurfaceWidth;
  NeedsDocker.Height := ScaleY(20);
  NeedsDocker.Caption := 'Docker Desktop  -  runs the database your agents live in';

  NeedsChrome := TCheckBox.Create(WizardForm);
  NeedsChrome.Parent := NeedsPage.Surface;
  NeedsChrome.Left := 0;
  NeedsChrome.Top := NeedsDocker.Top + NeedsDocker.Height + ScaleY(6);
  NeedsChrome.Width := NeedsPage.SurfaceWidth;
  NeedsChrome.Height := ScaleY(20);
  NeedsChrome.Caption := 'Google Chrome  -  the browser your agent acts through';

  NeedsFooter := TNewStaticText.Create(WizardForm);
  NeedsFooter.Parent := NeedsPage.Surface;
  NeedsFooter.Left := 0;
  NeedsFooter.Top := NeedsChrome.Top + NeedsChrome.Height + ScaleY(18);
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

{ Pages that would ask a question with only one right answer.

  Two cases. Nothing is missing, so there is nothing to offer to install. And an
  update, where the folder, the data directory and the ports all belong to the
  installation being updated -- offering them would let somebody move an
  installation by accident, which looks exactly like losing it. }
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if (PageID = NeedsPage.ID) and (not AnythingMissing()) then
    Result := True;

  { An update keeps the name it already has, so there is nothing to ask. }
  if UpdatingExisting() and (NamePage <> nil) and (PageID = NamePage.ID) then
    Result := True;

  if UpdatingExisting() then
  begin
    if PageID = wpSelectDir then Result := True;
    if (DataPage <> nil) and (PageID = DataPage.ID) then Result := True;
    if (PortsPage <> nil) and (PageID = PortsPage.ID) then Result := True;
  end;
end;

{ Ports that are already right when the page appears.

  Three empty boxes and "change them if something else uses one" asks somebody
  who has just downloaded this to go and find out what else on their PC is
  listening. So the first free port at each of the three defaults is filled in
  before the page is shown, and pressing Next is the correct answer.

  Only for a new installation, and only once, so somebody who edits a number
  does not have it taken back off them. }
procedure PreparePortsPage();
begin
  if PortsFilled then Exit;
  PortsFilled := True;
  if UpdatingExisting() then Exit;

  PortsPage.Values[0] := IntToStr(FirstFreePort(StrToInt(DefaultWebPort)));
  PortsPage.Values[1] := IntToStr(FirstFreePort(StrToInt(DefaultApiPort)));
  PortsPage.Values[2] := IntToStr(FirstFreePort(StrToInt(DefaultDbPort)));
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (PortsPage <> nil) and (CurPageID = PortsPage.ID) then
    PreparePortsPage();
  if CurPageID = NeedsPage.ID then
    PrepareNeedsPage();
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Problem: String;
  Chosen: Integer;
begin
  Result := True;

  { Leaving the first page with an existing installation chosen points the whole
    wizard at it, so the pages that follow are about that installation rather
    than about a new one in the default folder. }
  if (FoundPage <> nil) and (CurPageID = FoundPage.ID) then
  begin
    Chosen := ChosenInstall();
    if Chosen >= 0 then
      WizardForm.DirEdit.Text := Installs[Chosen].Program_;
  end;

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

  { And into the list, so the next installer can find this one even after a
    second installation has taken over the single uninstall entry. }
  RememberInstall(ExpandConstant('{app}'));
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
