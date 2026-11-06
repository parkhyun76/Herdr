#ifndef PayloadDir
  #error PayloadDir is required
#endif
#ifndef PackageOutput
  #error PackageOutput is required
#endif
#ifndef BuildLabel
  #define BuildLabel "0.1.12-personal.2"
#endif

[Setup]
AppId={{937B9717-E92C-421B-BC52-80D817CA62AA}
AppName=Herdr Personal
AppVersion={#BuildLabel}
AppPublisher=Herdr Personal fork
DefaultDirName={localappdata}\Programs\herdr-app
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.17763
OutputDir={#PackageOutput}
OutputBaseFilename=Herdr-Personal-{#BuildLabel}-Setup
SetupIconFile={#PayloadDir}\herdr-app.ico
UninstallDisplayIcon={app}\herdr-app.exe
LicenseFile={#PayloadDir}\app\LICENSE
InfoAfterFile={#PayloadDir}\INSTALL.txt
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
CloseApplications=no
RestartApplications=no
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Tasks]
Name: "layout"; Description: "개선된 화면을 기본 레이아웃으로 사용"
Name: "hooks"; Description: "이미 설정된 Codex / Claude Code에 대화 복원 연결 등록 (Codex 최초 승인 필요)"
Name: "desktopicon"; Description: "바탕 화면 바로가기 만들기"

[Files]
Source: "{#PayloadDir}\app\*"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\customizations\*"; DestDir: "{app}\customizations"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadDir}\session-tools\*"; DestDir: "{app}\session-tools"; Flags: ignoreversion
Source: "{#PayloadDir}\Initialize-HerdrPersonal.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\Initialize-HerdrPersonal.ps1"; Flags: dontcopy
Source: "{#PayloadDir}\INSTALL.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\package.json"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\Herdr Personal"; Filename: "{app}\herdr-app.exe"; WorkingDir: "{%USERPROFILE}"
Name: "{userdesktop}\Herdr Personal"; Filename: "{app}\herdr-app.exe"; WorkingDir: "{%USERPROFILE}"; Tasks: desktopicon

[Run]
Filename: "{app}\herdr-app.exe"; Description: "Herdr Personal 실행"; Flags: nowait postinstall skipifsilent

[Code]
function PowerShell: String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  ExtractTemporaryFile('Initialize-HerdrPersonal.ps1');
  if not Exec(PowerShell, '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\Initialize-HerdrPersonal.ps1') + '" -CheckRunning', '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode) then
    Result := 'Cannot check the running Herdr window.'
  else if ResultCode <> 0 then
    Result := 'Herdr 창을 닫은 뒤 다시 시도하세요. core와 AI 터미널은 종료할 필요가 없습니다.'
  else
    Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Args: String;
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then begin
    Args := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
      ExpandConstant('{app}\Initialize-HerdrPersonal.ps1') + '" -AppDir "' + ExpandConstant('{app}') + '"';
    if WizardIsTaskSelected('layout') then Args := Args + ' -ActivateLayout';
    if WizardIsTaskSelected('hooks') then Args := Args + ' -EnableAI';
    if not Exec(PowerShell, Args, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      RaiseException('Cannot configure Herdr Personal. See INSTALL.txt in the installation folder.');
    if ResultCode <> 0 then
      RaiseException('Herdr configuration failed. Existing files were backed up under %LOCALAPPDATA%\herdr-app-backups. See INSTALL.txt.');
  end;
end;
