; AI17Z Setup: the wrapper around Setup-AI17Z.ps1.
;
; This file, and the thing it compiles, do exactly one thing: put
; packaging\windows\Setup-AI17Z.ps1 on the disk and run it. There is no
; installation logic here, on purpose, because a compiled installer is the one
; artifact nobody can read -- and AI17Z Setup is allowed to install Windows
; features and system software, which is precisely the kind of program that
; should be readable.
;
; So the whole program is a PowerShell script in the public repository, and this
; is a launcher for people who quite reasonably expect to download one thing and
; double-click it. Both the .exe and the .ps1 are published with the release and
; both hashes are in SHA256SUMS.txt, so anybody can prove the script inside the
; .exe is the script in the repository.
;
; Two values are compiled in, and they are what makes a signed .exe a pin on
; what gets installed rather than a pin on a filename:
;
;   ReleaseTag      the exact release this .exe installs
;   PackageSha256   the SHA-256 the AI17Z package must have
;
; Without them the script falls back to the newest release and to the hash
; published in that release's SHA256SUMS.txt, which is weaker and which
; docs/SETUP_AUDIT.md says so about rather than glossing over.

#define AppName "AI17Z"
#define AppPublisher "AI17Z"
#define AppUrl "https://github.com/ShiftAboveCtrl/ai17z"
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
; Four numbers, because Windows will not accept a version resource with a
; prerelease suffix in it and Inno refuses the whole script over it.
#define NumericVersion Pos("-", AppVersion) > 0 ? Copy(AppVersion, 1, Pos("-", AppVersion) - 1) : AppVersion
#ifndef ReleaseTag
  #define ReleaseTag "v" + AppVersion
#endif
; Empty when nothing was passed. The script then reads the hash out of the
; release rather than refusing to run, and says which of the two it used.
#ifndef PackageSha256
  #define PackageSha256 ""
#endif

; Where the script is put. The same folder AI17Z Setup keeps its log and its
; resume note in, so everything setup owns is in one place somebody can look at
; and delete.
#define SetupHome "{localappdata}\AI17Z-setup"

[Setup]
; Distinct from the application's AppId: this installs nothing of its own and
; must never be mistaken for an installation of AI17Z.
AppId={{3F7C1D92-58AE-4D0B-9E7A-AI17ZSETUP001}
AppName={#AppName} Setup
AppVersion={#AppVersion}
AppVerName={#AppName} Setup {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
OutputDir=..\..\build\windows
OutputBaseFilename=Install-AI17Z-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupIconFile=ai17z.ico

; Nothing to choose, so nothing is asked. The status screen the script draws is
; the interface; a wizard in front of it would be two interfaces for one action.
CreateAppDir=no
Uninstallable=no
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableFinishedPage=yes
ShowLanguageDialog=no
; Per user. Nothing here needs administrator rights; AI17Z Setup asks for them
; itself, once, for the two Microsoft commands that genuinely require them, and
; explains why before the prompt appears.
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible

; What a person reads in the file properties, and what the release workflow
; checks before it publishes anything.
VersionInfoVersion={#NumericVersion}
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#NumericVersion}
VersionInfoTextVersion={#AppVersion}
VersionInfoProductTextVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} Setup
VersionInfoCopyright=MIT licensed

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; The whole program. Written somewhere stable rather than to {tmp}, because the
; run below does not wait for it -- and because somebody who wants to read what
; just ran on their machine should be able to find it afterwards.
Source: "Setup-AI17Z.ps1"; DestDir: "{#SetupHome}"; Flags: ignoreversion
Source: "ai17z.ico"; DestDir: "{#SetupHome}"; Flags: ignoreversion

[Run]
; nowait, so this window closes and leaves one console rather than two. The
; script owns the screen from here.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{#SetupHome}\Setup-AI17Z.ps1"" -Release ""{#ReleaseTag}"" -ExpectedSha256 ""{#PackageSha256}""{code:ScriptArguments}"; \
  WorkingDir: "{#SetupHome}"; \
  Flags: nowait

[Code]
{ The two things somebody may pass through to the script, and nothing else.

  Not a general pass-through. Everything here ends up on a PowerShell command
  line, and a switch that forwards arbitrary text to one is a way to run
  arbitrary code through a signed executable -- which would make the signature
  worth less than nothing. So: two flags, one of which is a name, and the name
  is reduced to the characters a folder name may contain before it goes
  anywhere near a command line.

  /INSTANCE=<name>  install a second, separate copy under that name
  /WHATIF           look at this PC and change nothing }

function CleanInstanceName(Raw: String): String;
var
  I: Integer;
  C: Char;
begin
  Result := '';
  for I := 1 to Length(Raw) do
  begin
    C := Raw[I];
    if ((C >= 'A') and (C <= 'Z')) or ((C >= 'a') and (C <= 'z')) or
       ((C >= '0') and (C <= '9')) or (C = '-') or (C = '_') or (C = '.') then
      Result := Result + C;
  end;
  { 48 is longer than any name worth having and short enough that nothing
    downstream has to think about length. }
  if Length(Result) > 48 then
    Result := Copy(Result, 1, 48);
end;

function ScriptArguments(Param: String): String;
var
  Instance: String;
begin
  Result := '';
  Instance := CleanInstanceName(ExpandConstant('{param:INSTANCE|}'));
  if Instance <> '' then
    Result := Result + ' -InstanceName "' + Instance + '"';
  if ExpandConstant('{param:WHATIF|no}') <> 'no' then
    Result := Result + ' -WhatIfOnly';
end;
