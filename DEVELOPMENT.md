# 개발 및 원격 저장소 운영

## 원격 저장소 역할

이 저장소는 원본 저장소의 변경사항을 계속 반영하면서, 개인 저장소에 작업 결과를
push하는 방식으로 운영한다.

| 이름 | 역할 | 주소 |
| --- | --- | --- |
| `upstream` | 원본 저장소에서 변경사항을 가져오는 원격 | `https://github.com/TheSmallHanCat/flow2api.git` |
| `origin` | 현재 작업 결과를 push하는 개인 원격 | `git@github.com:Gurumigun/flow2api.git` |

`main` 브랜치는 다음과 같이 설정되어 있다.

- pull/rebase 기준: `upstream/main`
- 기본 push 대상: `origin`

따라서 인자 없이 `git pull --rebase`를 실행하면 원본 변경사항을 가져오고,
`git push`를 실행하면 개인 저장소로 push한다.

## 원본 업데이트 반영

작업을 시작하기 전에 원본의 최신 변경사항을 반영한다.

```bash
git status
git fetch upstream
git rebase upstream/main
```

작업 트리에 커밋하지 않은 변경사항이 있어도 Git이 자동 임시 보관할 수 있지만,
중요한 변경사항은 먼저 별도 커밋하는 것을 권장한다.

충돌이 발생하면 각 충돌 파일에서 현재 작업과 원본 변경사항을 모두 확인한 뒤,
완료된 파일을 stage하고 rebase를 계속한다.

```bash
git status
git add <충돌을 해결한 파일>
git rebase --continue
```

동기화를 취소해야 할 때는 다음 명령으로 rebase 시작 전 상태로 돌아간다.

```bash
git rebase --abort
```

## 변경사항 검증 및 push

원본 동기화와 기능 구현이 끝나면 관련 테스트를 실행하고 커밋한다.

```bash
PYTHONPATH=. pytest -q
git diff --check
git add <변경된 파일>
git commit -m "type(scope): 변경 내용"
git push origin main
```

현재 모델 지원 변경처럼 이미지·영상 생성 경로를 수정한 경우에는 관련 테스트와
실제 API 스모크 테스트도 실행한다. 원본 업데이트와 충돌한 부분은 단순히 원본
쪽을 우선하지 말고, 기존 기능과 새 변경사항이 모두 유지되는지 확인한다.

## 한국어 관리 UI 유지 방식

원본 저장소의 `static/manage.html`, `static/login.html`, `static/test.html`은 주기적인
upstream 반영 시 충돌을 줄이기 위해 직접 번역하지 않는다. 서버의 공통 정적 페이지
응답 함수가 `static/i18n/ko.js`를 런타임에 주입하며, 이 스크립트가 정적 문구와
동적으로 생성되는 문구를 한국어로 바꾼다.

upstream에서 화면 문구가 추가되거나 변경된 경우 다음 순서로 보완한다.

1. 원본 HTML 변경은 그대로 받아들인다.
2. 화면에 남은 중국어 문구를 `static/i18n/ko.js`의 `exact` 또는 `phrases`에 추가한다.
3. `pytest -q tests/test_korean_ui.py`를 실행한다.
4. 로그인, 관리, 테스트 페이지를 열어 동적으로 생성되는 표·알림까지 확인한다.

CAPTCHA 방식의 `extension` 선택지는 원본 관리 화면에 포함하며, 로컬 로케일 레이어는
표시 문구만 번역한다. 관리 화면에서 저장한 값이 런타임 DB 설정으로 적용된다.

## 원격 및 브랜치 설정 확인

```bash
git remote -v
git branch -vv
git config --get branch.main.remote
git config --get branch.main.pushRemote
git rev-parse upstream/main
git rev-parse origin/main
```

`git push --force`는 원본 또는 개인 저장소의 다른 작업을 덮어쓸 수 있으므로
사용하지 않는다. push가 거부되면 먼저 `git fetch origin`으로 개인 저장소의
변경사항을 확인하고, 필요한 경우 해당 변경사항을 rebase한 뒤 다시 검증한다.
