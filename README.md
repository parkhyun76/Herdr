# Herdr_Upgrade

Herdr Windows 개인 개선판의 전체 앱 소스와 사용자 mod를 관리한다.
상위 프로젝트는 [herdrdev/herdr-app](https://github.com/herdrdev/herdr-app)이며
Apache-2.0 및 각 의존성의 라이선스·저작권을 유지한다.
전체 native 소스는 `native/herdr-app/`, 사용자 UI는 `mods/`에 있다.
[Windows 빌드·설치](docs/BUILD-WINDOWS.md) · [오류 기록·자동 개선](docs/DIAGNOSTICS.md)

기존 0.1.11 Windows 실행 파일은 [개인 개선판 릴리스](https://github.com/parkhyun76/Herdr/releases/tag/windows-custom-20261102)에서 받는다.
현재 소스는 공식 0.1.12를 합친 `0.1.12-personal.2`이며 빌드 방법은 위 안내를 따른다.
공식 앱·core와 구분되는 개인 빌드이며 기존 core 설치가 필요하다.

## 구성

| 경로 | 내용 |
|---|---|
| `mods/changes-branch/` | 우측 Changes 패널. **Working / 미푸시 / vs main** 전환과 커밋별 변경 조회 |
| `mods/spaces-foldable/` | 좌측 Spaces 목록. 프로젝트별 하위 역할 접기, **+ (새 워크트리)**, **↑숫자 클릭 푸시** |
| `mods/tabs-inline-add/`, `mods/files-utf8/` | 탭 바, Files 패널 복제본 |
| `layouts/main-worktree-folding.json` | 위 mod들을 쓰는 레이아웃 |
| `upstream/<버전>/` | 복제 당시 Herdr 기본 mod·레이아웃 원본. 업데이트 후 바뀐 부분을 병합할 때 기준 |
| `scripts/deploy-mods.ps1` | `mods/*`, `layouts/*.json`을 `~/.config/herdr-app/`로 복사 (Herdr가 즉시 핫 리로드) |
| `scripts/check-herdr.ps1` | Herdr가 이 저장소의 mod·레이아웃을 그대로 쓰는지 점검 (`-Fix`: 복구) |
| `tests/` | `git.js` 테스트 (`node --test`) |
| `native/herdr-app/` | 앱 전체 Rust/GPUI 소스, 기본 UI, 라이선스, 고정 Ghostty 서브모듈 |
| `scripts/repair-herdr.cjs` | 오류별 격리 수정·검사·조건부 적용 작업자 |

## 작업 흐름

1. 이 저장소의 `mods/` 아래를 수정한다. (`~/.config/herdr-app/mods/` 쪽은 배포본이라 직접 고치지 않는다)
2. `node --test tests/*.test.cjs tests/*.test.mjs` 로 루트 검사만 실행한다.
3. `pwsh scripts/deploy-mods.ps1` 로 배포한다.
4. `herdr-app status` 의 `errors`가 비었는지, 화면에서 동작하는지 확인한다.

정션(junction)으로 연결하면 Herdr가 파일 변경을 감지하지 못해 핫 리로드가 되지 않으므로 복사 방식을 쓴다.

## Herdr 업데이트 뒤

```powershell
pwsh scripts/check-herdr.ps1        # 점검만
pwsh scripts/check-herdr.ps1 -Fix   # 저장소 내용으로 다시 배포하고 레이아웃을 main-worktree-folding으로 되돌림
```

점검 항목: 배포된 mod·레이아웃이 저장소와 같은지, 사용 중인 레이아웃, `*.error` 파일과 `herdr-app status`의 errors,
Herdr가 남긴 `-edited` / `.reset-` / `.old-` 파일, 그리고 복제 원본인 기본 mod(`spaces`, `tabs`, `files`, `changes`)가
`upstream/<cloned_from 버전>/`과 달라졌는지.

마지막 항목이 뜨면 Herdr가 기본 mod를 고친 것이다. `-Fix`로는 해결되지 않으므로, 바뀐 내용을 복제본에 병합한다
(`git merge-file mods/<복제본>/main.js upstream/<옛 버전>/mods/<원본>/main.js ~/.config/herdr-app/mods/<원본>/main.js`).
그다음 새 버전의 원본을 `upstream/<새 버전>/`에 저장하고, 복제본 `mod.json`의 `cloned_from.version`을 올린다.

Herdr 안내(`AGENTS.md`)에 따르면 업데이트는 기본 mod·레이아웃만 덮어쓴다. 복제본(`cloned_from`이 있는 것)은 건드리지 않는다.
기본 파일을 직접 고쳤다면 Herdr가 그 파일을 `<이름>-edited`로 옮기고 원래대로 되돌린다.
그러니 기본 mod는 직접 고치지 않는다. 항상 `mod.clone`으로 복제한 뒤 이 저장소에서 관리한다.

## changes-branch

- **Working**: 커밋하지 않은 변경 (`git status`, `git diff HEAD`) + 커밋 입력창
- **vs main**: 브랜치가 main에서 갈라진 뒤 커밋한 내용 (`git diff <base>...HEAD`)과 ahead/behind 수.
  base는 `main` → `master` → `origin/main` → `origin/master` 중 처음 있는 것.
- **미푸시**: 추적 브랜치에 없는 커밋의 메시지·작성 시각을 표시하고, 커밋을 선택하면 해당 커밋의 파일과 상세 차이를 보여준다. `main`에서도 사용할 수 있으며 커밋 전 수정은 섞이지 않는다.
  로컬에 저장된 원격 정보를 기준으로 읽고 자동 fetch/push는 하지 않는다. 원격 미설정·참조 누락·조회 오류를 빈 목록과 구분한다. 최근 100개 커밋을 표시하며 전체 미푸시 수는 탭에 표시한다.
- 전환: 패널 버튼, 또는 `herdr-app do changes-branch.toggle` (`working` / `branch`).
  미푸시 탭은 `herdr-app do changes-branch.unpushed`로 열 수 있다.
- 좌측 워크스페이스의 **↑숫자**를 클릭하면 해당 브랜치를 추적 원격 브랜치로 즉시 일반 푸시한다. 진행 중은 **↑…**로 표시하고 중복 클릭을 막는다. 결과를 알림으로 표시한 뒤 같은 저장소의 숫자를 갱신한다. **↓숫자**는 받아올 커밋 수 표시다.
  클릭한 브랜치·저장소가 아직 같은지 확인하며, 원격 이력과 충돌하면 오류를 표시한다. 커밋 전 파일은 그대로 두고 지정된 브랜치 한 곳을 푸시한다.
  `keys.json`에 `"changes-branch:toggle"`을 연결하면 단축키로 쓸 수 있다.
- 사용 레이아웃 `main-worktree-folding`의 `changes` 블록이 이 mod를 가리킨다.

## Files의 Windows 탐색기 아이콘

로컬 Windows의 Files 패널은 Windows Shell에서 현재 PC의 파일 연결 아이콘을
가져온다. 폴더·Excel·Word·PDF 등은 탐색기와 같은 컬러 아이콘을 표시하며,
실행 파일·바로가기·아이콘 파일은 개별 아이콘을 조회한다. 등록되지 않은 형식은
Windows의 기본 파일 아이콘을 쓴다. 원격 기기와 다른 OS는 기존 아이콘을 유지한다.

`mods/files-utf8/list-windows.ps1`이 백그라운드에서 조회하고 앱 홈의
`data/files-utf8/windows-icons-v1/`에 내용 해시를 이름으로 PNG를 캐시한다.
탐색하는 폴더에는 파일을 만들지 않는다. 파일 연결 변경은 다음 목록 갱신에
다시 조회하며, 아이콘 조회 실패는 패널 하단에 표시하고 기존 아이콘을 사용한다.
설치는 `scripts/deploy-mods.ps1`에 포함되며 앱 재시작이 필요 없다.
로컬 Windows의 파일을 더블클릭하면 Windows에 연결된 기본 프로그램으로 연다.
한 번 클릭하면 더블클릭 대기 시간 이후 기존과 같이 미리보기를 표시한다.

## Windows AI 대화 자동 복원

Files 왼쪽의 **대화 저장·복원** 버튼을 누르면 선택 창이 열린다.
**지금 저장**은 모든 로컬 워크스페이스의 대화 연결을 즉시 관측·저장하고,
**저장된 대화 복원**은 사라진 AI만 기존 탭에서 재개한다. 실행 중인 대화를
중복 실행하거나 직접 닫은 탭을 다시 만들지 않는다. 처리 완료/문제는 화면
알림으로 표시하며 자동 저장·복원도 계속 작동한다. 대화 본문을 따로 복사하는
기능은 아니다. CLI는 `session.save`, `session.restore`, `session.status`다.

`-personal.*` 개인 빌드는 공식 앱 자동 다운로드·교체를 차단해 본체 수정을
보호한다. core 업데이트는 별도 유지한다. 앱 업데이트는 공식 변경을 합친
검증된 개인 빌드를 설치하는 방식으로 진행한다.

사용자 native 빌드에 대화 연결 저장 기능을 추가했다. Claude Code·Codex의 정확한
대화 ID를 워크스페이스·탭·분할 창 ID와 연결한다. 시작·전환 이벤트와 변경을 저장하고,
5분마다 보완 점검하며 정상 종료 전에 마지막 상태를 저장한다. 대화 본문은 각 AI의
기존 저장소에 두고 연결 정보만 `%LOCALAPPDATA%/Herdr/session-restore.json`에 저장한다.
별도 앱 홈이나 core 세션은 충돌을 피하기 위해 접미사가 붙은 파일을 사용한다.

- 앱만 다시 열거나 core 재시작 후 AI가 살아 있으면 기존 연결을 사용한다.
- 실제 터미널 손실 후 core가 복구한 셸에 대해서만, 이전 대화를 새 터미널에서 재개해 원래 pane에 배정한다.
- 직접 닫은 창·정상 종료한 AI·다른 창에서 이미 실행 중인 대화는 다시 시작하지 않는다.
- 정확한 ID/대화 파일/폴더를 확인하지 못하면 최근 대화로 대체하지 않는다.
- 복원 자체는 새 작업 지시를 보내지 않는다. 기존 모델·권한 옵션 중 확인된 항목만 유지한다.
- 현재 대상은 로컬 Windows 터미널이다. 원격 기기의 복원 동작은 변경하지 않는다.

`herdr-app status`의 `session_restore`에서 저장 건수·확인 대기 창·오류를 확인한다.
앱을 닫은 상태에서 저장 파일의 `enabled`를 `false`로 바꾸면 자동 복원을 끌 수 있다.
연결 저장에는 원자적 파일 교체·직전 정상 사본·단일 작성자 잠금을 사용한다.

native 원본은 `native/herdr-app/`, 이전 유지보수 패치는 `patches/`에 있다.
`scripts/install-session-restore.cjs`는 기존 설정을 백업하고 이 기능의 AI 훅만 추가하며,
Codex가 제공한 정확한 훅 해시를 config API로 신뢰 등록한다. 기존 훅·권한 설정은 보존한다.
앱 업데이트로 native 실행 파일이 교체되면 이 기능의 패치도 다시 반영해야 한다.

## 오류 기록과 자동 개선

클릭 명령 실패·스크립트/화면 오류·설정 오류·panic을 앱 홈 `diagnostics/`에
상세 기록하고 반복 오류를 묶는다. 일시적인 화면 오류에는 제한된 재시도를 한다.
`herdr-app status`의 `diagnostics`에서 기록·자동 수정 상태를 확인한다.

`scripts/install-auto-repair.ps1`로 활성화하면 별도 Git 작업 폴더에서 Codex가
수정안을 만들고, 경로 제한·기존 파일 확인·검사를 통과한 변경만 적용한다.
하루 기본 3회·15분 대기 제한이 있으며 UI 변경은 핫 리로드, native 변경은
앱 종료 후 백업과 해시 확인을 거쳐 설치한다. GitHub에는 자동 푸시하지 않는다.
설정·로그·인증정보·대화 이력·실행 파일은 이 소스 저장소에 포함하지 않는다.
