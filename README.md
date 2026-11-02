# Herdr_Upgrade

Herdr 데스크톱 앱 개선 작업. Herdr의 인터페이스는 `~/.config/herdr-app/` 파일들이고
(공식 안내: 그 폴더의 `AGENTS.md`), 이 저장소는 그중 직접 만든 mod의 원본을 관리한다.

## 구성

| 경로 | 내용 |
|---|---|
| `mods/changes-branch/` | 우측 Changes 패널. 기본 `changes` mod를 복제해 **Working / vs main** 전환을 추가 |
| `scripts/deploy-mods.ps1` | `mods/*`를 `~/.config/herdr-app/mods/`로 복사 (Herdr가 즉시 핫 리로드) |
| `tests/` | `git.js` 테스트 (`node --test`) |

## 작업 흐름

1. 이 저장소의 `mods/` 아래를 수정한다. (`~/.config/herdr-app/mods/` 쪽은 배포본이라 직접 고치지 않는다)
2. `node --test` 로 테스트한다.
3. `pwsh scripts/deploy-mods.ps1` 로 배포한다.
4. `herdr-app status` 의 `errors`가 비었는지, 화면에서 동작하는지 확인한다.

정션(junction)으로 연결하면 Herdr가 파일 변경을 감지하지 못해 핫 리로드가 되지 않으므로 복사 방식을 쓴다.

## changes-branch

- **Working**: 커밋하지 않은 변경 (`git status`, `git diff HEAD`) + 커밋 입력창
- **vs main**: 브랜치가 main에서 갈라진 뒤 커밋한 내용 (`git diff <base>...HEAD`)과 ahead/behind 수.
  base는 `main` → `master` → `origin/main` → `origin/master` 중 처음 있는 것.
- 전환: 패널 버튼, 또는 `herdr-app do changes-branch.toggle` (`working` / `branch`).
  `keys.json`에 `"changes-branch:toggle"`을 연결하면 단축키로 쓸 수 있다.
- 사용 레이아웃 `main-worktree-folding`의 `changes` 블록이 이 mod를 가리킨다.
