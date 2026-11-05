# 공유 클라이언트 수동 점검 (darkpyonix#20)

Refs DarkPyonix/darkpyonix#20, SPEC FR-A2, FR-A3, FR-A4, FR-A6, FR-S2, FR-S3, FR-S8, FR-S9, FR-R4.
실제 브라우저와 실제 전용 매니저로 확인합니다. 자동 시험(jest)은 브라우저의 sandbox/CSP 집행과 화면 흐름을 보지 못하므로, 이 문서가 그 부분의 유일한 확인 절차입니다.

**마스터 토큰과 공유 토큰은 로그, 이슈, 스크린샷, HAR 파일에 남기지 않습니다.** WebSocket 주소의 쿼리에는 `token=`이 들어 있습니다(FR-S9 설계). 개발자 도구 네트워크 탭 화면을 공유하지 마세요.

## 0. 알아 둘 것

- 공유 링크 `<share_base>/<share_id>#<token>`은 매니저 주소와 커널 ID를 담지 않습니다(허브가 풀어 주는 경로는 FR-H4). 허브 없이 직접 연결하려고 ash는 쿼리 `?manager=<매니저 URL>&kernel=<커널 ID>`를 씁니다. **이 두 매개변수는 ash 로컬 규약이며 core SPEC에 없습니다.**
- 공유 모드로 들어가는 조건: `#token=<token>` 또는 `?token=<token>`이 있거나, 맨 `#<token>`이 `/s/<share_id>` 경로 또는 `manager`+`kernel` 쌍과 함께 있을 때입니다. `index.html#anchor` 같은 평범한 주소는 기존 ash 동작 그대로입니다(시험으로 보장).
- 능력은 `read`, `history`, `execute`, `edit`, `manage` 다섯이고 서로 독립입니다(FR-A3, INTENT D18). 등급이 아닙니다.

## 1. 사전 준비

1. 전용 매니저를 띄우고, 출력이 있는 셀(예: `print("visible-output")`)이 두세 개 있는 `.py` 파일의 커널을 시작합니다. 파일을 한 번 실행해 실행 기록을 만듭니다.
2. 마스터 토큰은 매니저를 띄운 쪽에서 확인합니다(FR-A4). 터미널 기록에 남지 않게 셸 변수에만 담습니다: `read -s MASTER`, `MANAGER=http://127.0.0.1:<포트>`.
3. 커널 ID 찾기: `curl -s -H "Authorization: Bearer $MASTER" $MANAGER/api/kernels`에서 해당 파일의 `kernel_id`를 고르고 `KID`에 담습니다.
4. 능력 조합별 공유 만들기. 응답의 `token`은 **한 번만** 보이고, `share_id`는 해지에 씁니다. 응답을 셸 변수에만 담고 화면에 출력하지 않습니다.

   ```
   mk() { curl -s -X POST -H "Authorization: Bearer $MASTER" -H "Content-Type: application/json" \
     -d "{\"capabilities\":$1,\"label\":\"$2\"}" $MANAGER/api/kernels/$KID/shares; }
   R_READ=$(mk '["read"]' read)
   R_HIST=$(mk '["read","history"]' history)
   R_EXEC=$(mk '["read","history","execute"]' execute)
   R_EDIT=$(mk '["read","edit"]' edit)
   R_ALL=$(mk '["read","history","execute","edit"]' all)
   R_EXONLY=$(mk '["execute"]' noread)
   ```

   토큰과 share_id는 `jq -r .token`, `jq -r .share_id`로 꺼내 변수에 담습니다(`T_READ`, `S_READ` 등).
5. 공유 링크는 `https://<ash 주소>/?manager=$MANAGER&kernel=$KID#$T_READ`처럼 만듭니다. 새 시크릿 창에서 엽니다(이전 공유의 상태가 섞이지 않게).

## 2. 시나리오별 기대 결과

### 2.1 read: 읽기 전용
링크 `T_READ`로 엽니다.
- 상단 안내가 "읽기 전용 공유: 코드 보기"로 시작합니다.
- 셀 코드가 보이고 편집할 수 없습니다(편집기가 잠긴 상태). **출력은 없습니다**(`history` 없음).
- 실행 단추는 화면에 남아 있지만 눌러도 아무 요청도 나가지 않습니다(네트워크 탭에 요청 없음).
- "실행 중단" 단추가 없습니다. 셀 추가·삭제·이동·유형 변경이 모두 막혀 있습니다.

### 2.2 read+history: 출력 보기
링크 `T_HIST`.
- 안내는 "읽기 전용 공유: 코드 보기, 실행 기록과 출력 보기".
- 각 셀 아래에 마지막 실행의 출력이 보입니다(stream, 오류 트레이스백, 이미지, text/plain).
- 마스터 토큰으로 다른 곳에서 실행하면(`curl -X POST -H "Authorization: Bearer $MASTER" -H "Content-Type: application/json" -d '{"mode":"all"}' $MANAGER/api/kernels/$KID/runs`) 새로고침 없이 출력이 실시간으로 바뀝니다.

### 2.3 read+history+execute: 실행과 인터럽트
링크 `T_EXEC`.
- 안내 줄에 "실행 중단" 단추가 있습니다.
- 셀의 실행 단추를 누르면 `POST /api/kernels/<KID>/runs`가 나갑니다(`mode: cells`, `cell_ids`). **브라우저(WASM)에서 로컬 실행되지 않습니다.** 출력은 소켓으로 들어와 실시간으로 보입니다.
- 오래 걸리는 셀(`import time; time.sleep(60)`)을 실행하고 "실행 중단"을 누르면 `POST .../interrupt`가 나가고 셀이 `KeyboardInterrupt`로 끝납니다.
- 실행 중에 또 실행하면 다른 실행이 진행 중이라는 한국어 오류("다른 실행이 진행 중입니다")가 안내 줄에 뜹니다.
- 코드 편집은 되지 않습니다(`edit` 없음).

### 2.4 read+edit: 셀 편집
링크 `T_EDIT`.
- 안내는 "공유: 코드 보기, 코드 수정"(`execute`가 없으므로 실행 단추는 요청을 보내지 않음, 중단 단추 없음).
- 셀 코드를 고치면 약 0.8초 뒤 `PUT .../cells/<id>/lock` → `PATCH .../cells/<id>`(본문에 `base_version`, `source`)가 나가고, 약 5초 조용하면 `DELETE .../lock`이 나갑니다. 입력 중 커서와 포커스가 유지됩니다(저장할 때 셀이 다시 그려지지 않음).
- 다른 창(마스터 토큰으로 `PATCH`)에서 같은 셀을 고치면 이쪽 화면에 반영됩니다. 이쪽에 저장 전 편집이 있는 셀은 그 편집이 먼저 가고, 서버가 더 새 버전이면 "다른 곳에서 먼저 수정되어 변경을 저장하지 못했습니다"가 뜨고 서버 버전이 보입니다(조용히 덮어쓰지 않음).
- 다른 사용자가 잠근 셀을 고치면 "다른 사용자가 수정 중인 셀입니다"가 뜨고, 잠금이 풀리면 자동으로 다시 시도합니다.
- 셀 추가·삭제·이동은 REST로 가고 결과가 화면에 반영됩니다(이동은 0번 프리앰블 앞으로 못 감).
- 저장하지 않은 편집이 있는 채로 탭을 닫으려 하면 브라우저가 확인을 묻습니다.
- 셀 유형 변경, 속성 변경, 리셋, 지우기는 막혀 있습니다(알려진 한계 참고).

### 2.5 read+history+execute+edit
링크 `T_ALL`: 2.2~2.4가 모두 됩니다. `execute`와 `edit`은 독립이라 각 동작이 해당 능력에만 의존해야 합니다(2.3의 실행이 `edit` 없이, 2.4의 편집이 `execute` 없이 되는 것을 위 두 공유로 이미 확인).

### 2.6 HTML 출력: 기본은 텍스트, 단추로 격리된 틀
`text/html` 출력을 내는 셀을 준비합니다(예: 커널이 `display_data`에 `text/html`을 싣는 셀. 어떤 코드로 만들지는 커널 환경에 따라 다르니, 마스터 토큰으로 실행 기록에 그런 출력이 들어 있는 파일을 쓰세요).
- 기본: HTML이 그려지지 않고 `text/plain` 대안(없으면 "HTML 출력입니다. 보안을 위해 기본으로는 표시하지 않습니다.")만 보이며 "격리된 틀에서 HTML 보기" 단추가 있습니다.
- 단추를 누르면 그 자리에 iframe이 생깁니다. 개발자 도구 요소 탭에서 확인: `sandbox=""`(값이 비어 있음, `allow-` 어떤 것도 없음), `referrerpolicy="no-referrer"`, `csp` 속성, `srcdoc`의 `<head>` 맨 앞쪽에 `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ...">`가 `<body>`보다 앞에 있음.
- 악성 출력 확인(셀 코드로 만든 `text/html` 출력, **자기 환경에서만**): `<script>alert(1)</script>`, `<img src=x onerror=alert(1)>`, `<a href="javascript:alert(1)">x</a>`, `<iframe src="https://example.com">`, `<meta http-equiv=refresh content="0;url=https://example.com">`, `<svg onload=alert(1)>`, `<map><area href=https://example.com></map>`를 각각 담은 출력. 기대: 경고창이 뜨지 않고, 틀이 다른 페이지로 이동하지 않고, `srcdoc` 안에 해당 요소/속성이 없습니다. 콘솔에 CSP 위반이 보여도 정상입니다.
- 1MB(UTF-8 바이트)를 넘는 HTML은 단추 없이 텍스트만 보입니다.

### 2.7 해지 감지
마스터 토큰으로 공유를 해지합니다: `curl -s -X DELETE -H "Authorization: Bearer $MASTER" $MANAGER/api/kernels/$KID/shares/$S_xxx`.
- **read가 있는 공유**(2.1~2.5): 페이지가 소켓을 열어 두고 있으므로 해지하면 소켓이 닫히고, 페이지가 `verify`로 확인해 "공유가 해지되었습니다"를 띄웁니다. 이후 실행·편집·인터럽트가 모두 막히고, 개발자 도구 네트워크 탭에 **새 요청도 새 WebSocket도 생기지 않습니다**(이미 끝난 공유로 재연결을 시도하지 않음).
- **read가 없는 공유**(`R_EXONLY`, `execute`만): 문서도 소켓도 없으므로 해지해도 화면은 그대로입니다(폴링 없음, 리더 결정). 이 상태에서 실행(또는 중단)을 누르면 그 REST 호출이 401 `token_revoked`를 받는 순간 "공유가 해지되었습니다"가 뜨고 이후 모든 조작이 막힙니다. 이 공유로 문서가 안 보이는 것은 정상입니다(`read` 없음).
- 편집 중 해지: 보내지 못한 편집은 버려지고 "공유가 해지되었습니다"만 한 번 뜹니다(저장 실패 경고가 그 문구를 덮지 않음).
- 잘못된 토큰: "공유 토큰이 올바르지 않습니다". 커널이 없으면 "공유된 커널을 찾을 수 없습니다". 매니저를 잠깐 끄면 "다시 연결하는 중..."이 뜨고 백오프(약 1, 2, 4, 8, 16초, 지터 있음)로 최대 5번 재시도한 뒤 "매니저와 연결이 끊겼습니다. 페이지를 다시 불러오세요"가 뜹니다.

## 3. 개발자 도구 확인 항목

| 항목 | 확인 방법 | 기대 |
|---|---|---|
| 주소창 토큰 제거 | 링크를 열고 주소창을 봅니다 | 읽은 직후 `#token`/`?token=`이 사라집니다(`manager`, `kernel`은 남음). 뒤로 가기 기록에도 토큰이 없음 |
| 로컬 실행 없음 | 네트워크 탭, 콘솔 | pyodide/WASM 로드와 로컬 셀 실행이 없고 실행은 `POST .../runs`로만 감 |
| 요청 헤더 | 아무 REST 요청 | `Authorization: Bearer ...`, `X-DarkPyonix-Client: ash_...`(8~64자 영숫자 `_` `-`) |
| 요청 없음(능력 부족) | read 공유에서 실행/편집 시도 | 요청이 아예 나가지 않음 |
| WebSocket | 네트워크 탭의 `ws/kernels/<id>` | `101`, 메시지에 `history_data`(history 있을 때), 연결 주소 쿼리에 `token=`(공유 금지) |
| iframe | 요소 탭 | 2.6과 같음: `sandbox=""`, CSP meta가 body보다 앞 |
| 해지 후 | 네트워크 탭 | 새 요청/새 WS 없음 |
| 콘솔 | 콘솔 | 토큰 문자열이 어디에도 찍히지 않음(검색해서 확인) |

## 4. 알려진 한계 (이번 범위 밖)

- 셀 유형 변경, 셀 속성 변경(접기 등), 셀 리셋, 지우기는 공유 모드에서 막혀 있습니다(API에 안전한 대응이 없음).
- `read`가 없는 공유는 해지를 폴링으로 알아내지 않고 다음 REST 호출에서 압니다(리더 결정).
- `text/html` 출력의 틀은 높이가 고정(300px, 세로 크기 조절 가능)이고 자동 높이가 없습니다(스크립트와 postMessage를 쓰지 않으므로). 틀 안 링크는 동작하지 않습니다.
- 브라우저의 bfcache로 페이지가 복원되면(뒤로/앞으로 가기) 소켓과 편집기가 닫힌 상태라서 "공유 링크로 다시 접속하세요"가 뜨고 조작이 막힙니다. 새로고침은 토큰이 주소창에 없어 쓸 수 없습니다.
- 편집 중 탭을 닫으면 잠긴 셀의 최종 소스는 60KB 이하일 때만 한 번의 keepalive 요청으로 저장되고 잠금이 풀립니다. 그보다 크거나 아직 잠그지 못한 편집은 저장되지 않고(브라우저 확인창이 먼저 경고), 서버의 잠금은 3분 뒤 풀립니다(FR-S3).
- 실제 브라우저에서의 화면 흐름(편집기 잠금 해제, 셀 재생성, 단추 표시)은 자동 시험 밖입니다. 이 문서의 2절이 그 확인입니다.
- 소유자 환경의 실제 브라우저 확인 결과는 darkpyonix#20에 기록합니다.

## 5. 정리
- 공유 해지: `curl -s -X DELETE -H "Authorization: Bearer $MASTER" $MANAGER/api/kernels/$KID/shares/$SHARE_ID`. 공유 목록은 `GET .../shares`(토큰은 다시 보이지 않음).
- 점검이 끝나면 `unset MASTER T_READ T_HIST T_EXEC T_EDIT T_ALL` 등 셸 변수를 지우고, 시크릿 창을 닫습니다.
