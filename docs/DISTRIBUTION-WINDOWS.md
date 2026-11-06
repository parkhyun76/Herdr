# Windows 동료 배포

`dist/Herdr-Personal-0.1.12-personal.2-20261106-Setup.exe`를 동료에게 전달한다.
설치 프로그램에 앱, 개인 모드 7개, 기본 레이아웃, 대화 연결 도구, 라이선스와
Microsoft Visual C++ 런타임 DLL이 포함된다. 같은 폴더의 `INSTALL.txt`는 사용자
설명서이고 `SHA256SUMS.txt`는 설치 파일의 무결성 확인용이다.

대상은 Windows 10 1809 이상 x64다. 관리자 권한 없이 현재 사용자에게 설치하며,
시작 메뉴와 선택한 경우 바탕 화면에 바로가기를 만든다. 처음 앱을 열 때 core가
없으면 앱의 **Install it for me**로 설치한다. 이 단계에는 인터넷이 필요하다.
Git과 각 AI CLI는 동료가 설치하고 자기 계정으로 로그인한다.

설치 프로그램은 기존 Herdr 창을 닫으라고 안내하며 프로세스를 종료하지 않는다.
실행 중 core와 AI를 유지한다. 기존 모드·레이아웃의 교체 파일과 변경할 AI 훅
설정은 `%LOCALAPPDATA%/herdr-app-backups/personal-setup-<고유값>/`에 백업한다.
다른 사용자 설정과 모드 저장 데이터는 보존한다. 이전 실행 파일을 보관해야
한다면 설치 전 별도 백업한다. 제거 시 사용자 설정·대화·훅·core는 삭제하지 않는다.

**대화 연결 등록**을 선택하면 이미 초기 설정된 Codex/Claude의 네 가지 이벤트에
Herdr의 연결 훅만 추가한다. 다른 훅·권한은 유지하고 Codex의 신뢰 설정을 자동으로
변경하지 않는다. Codex에서 해당 훅의 승인을 요청하면 사용자가 확인·승인한다.
나중에 AI를 설치했을 때의 재등록 명령은 `INSTALL.txt`에 있다.
다른 PC의 대화를 이동하거나 자동 소스 수정 작업자를 활성화하지 않는다.

개인 인증·대화·워크스페이스는 수집하지 않는다. 패키징은 저장소의 추적된 모드와
레이아웃 및 명시한 실행 파일만 읽는다. `package.json`에 소스 커밋, 실행 파일
SHA256과 포함 파일의 SHA256을 기록한다. `dist/`는 Git에서 제외된다.
현재 설치 파일은 코드 서명되지 않은 개인 배포본이다.

## 재생성

Inno Setup 6.4 이상과 Visual Studio 2022 x64 재배포 런타임 파일이 필요하다.
실행 파일은 먼저 Windows 소스 빌드 절차로 빌드·검증한다. 검증한 실행 파일의
SHA256을 필수 인자로 넘겨 다른 바이너리의 실수 배포를 막는다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/distribution-windows.tests.ps1
./scripts/build-distribution.ps1 `
  -ExpectedBinarySha256 94F2AB011F0D7740D95B1C141412959055C433A7BA03A7AE1CC083821F2F3530
```

다른 검증 빌드는 `-Binary`, `-ExpectedBinarySha256`, `-BuildLabel`을 함께 바꾼다.
컴파일러나 재배포 DLL 경로가 다르면 `-Compiler`와 `-RuntimeDll`로 지정한다.
RuntimeDll은 Microsoft의 유효한 서명이 있어야 한다. Windows 시스템 폴더의
파일을 복사하지 않고 Visual Studio의 x64 `VC/Redist` 파일을 사용한다.
파일 배포 근거는 [Microsoft의 재배포 목록](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution)에 있다.

단위 검증은 OS 임시 폴더에서 새 설치·한글 경로·기존 데이터 보존·백업·복구와
훅 등록·재등록·신뢰 설정 보존을 확인한 뒤 임시 폴더를 삭제한다.
실제 설치 프로그램의 컴파일도 확인한다. 실행 중인 개발자의 앱에 설치하거나
동료의 새 PC에서 전체 설치·실행을 완료한 것으로 간주하지 않는다.
