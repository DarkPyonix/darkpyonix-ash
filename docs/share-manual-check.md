# 공유 클라이언트 수동 점검 (darkpyonix#20)

Refs DarkPyonix/darkpyonix#20, SPEC FR-A2, FR-A3, FR-S9. 실제 브라우저와 실제 전용 매니저로 확인합니다.
마스터 토큰과 공유 토큰은 로그, 이슈, 스크린샷에 남기지 않습니다.

표시: **[PR1]** 은 이 PR(클라이언트 코어)만으로 확인할 수 있는 항목, **[PR2 후]** 는 ash 페이지 연결(UI 게이팅)이 들어간 뒤에 확인할 항목입니다.

## 0. ash 로컬 규약
공유 링크 `<share_base>/<share_id>#<token>`은 매니저 주소와 커널 ID를 담지 않습니다(허브가 풀어 주는 경로는 FR-H4). 허브 없이 직접 연결할 때를 위해 ash는 쿼리 `?manager=<매니저 URL>&kernel=<커널 ID>`를 씁니다. 이 두 매개변수는 **ash 로컬 규약이며 core SPEC에 없습니다.** 토큰은 `#<token>`(권장) 또는 `?token=`(FR-A2)으로 받습니다.

## 1. 준비
1. 전용 매니저를 띄우고, 출력이 있는 셀이 하나 이상 있는 파일의 커널을 시작합니다. 한 번 실행해 실행 기록을 만듭니다.
2. 마스터 토큰은 매니저를 띄운 쪽에서 확인합니다(FR-A4). 로컬 셸 변수에만 담습니다: `read -s MASTER`.
3. 커널 ID 찾기: `curl -s -H "Authorization: Bearer $MASTER" $MANAGER/api/kernels`에서 해당 파일의 `kernel_id`를 고릅니다.
4. 공유 만들기(능력 세 가지). 응답의 `token`은 한 번만 보입니다. `share_id`는 폐기에 씁니다.
   `curl -s -X POST -H "Authorization: Bearer $MASTER" -H "Content-Type: application/json" -d '{"capabilities":["read"]}' $MANAGER/api/kernels/$KID/shares`
   본문을 `["read","history"]`, `["read","history","execute"]`로 바꿔 두 번 더 만듭니다.

## 2. 단계와 기대 결과 [PR1]
토큰마다 브라우저 개발자 도구 콘솔(또는 `curl`)로 확인합니다. 능력이 없는 작업은 **서버가** 막고(권한 검사는 매니저), ShareClient는 능력을 알고 나면 요청을 보내지 않고 `ShareForbiddenError`를 던집니다.

| 공유 | `GET .../tokens/<token>/verify` | `GET .../document` | `GET .../runs` | `POST .../runs` | WS `request_history` | WS `start_typing` |
|---|---|---|---|---|---|---|
| read | `["read"]` | 200, 셀에 outputs 없음 | 403 | 403 | `history` 빈 배열 | `error: INSUFFICIENT_PERMISSION` |
| read+history | `["read","history"]` | 200, outputs 있음 | 200 | 403 | 항목 있음 | `INSUFFICIENT_PERMISSION` |
| read+history+execute | `execute` 추가 | 200, outputs 있음 | 200 | 202 | 항목 있음 | `INSUFFICIENT_PERMISSION` |

모든 공유에서 `POST .../cells`, `PUT .../cells/<id>/lock`은 403입니다(`edit` 없음). 다른 커널을 가리키면 403이 아니라 404입니다.

## 3. 브라우저에서 WebSocket 응답 보기 [PR1]
개발자 도구 네트워크 탭에서 `ws/kernels/<id>` 연결을 고르고 메시지(Messages) 탭을 봅니다. `request_history`를 보내면 `history_data`가 옵니다. **WebSocket 주소의 쿼리에는 `token=`과 `client_id=`가 들어 있습니다**(FR-S9 설계). 그래서 네트워크 탭 화면과 HAR 파일을 공유하지 마세요. ShareClient의 오류 메시지와 close 사유에서는 토큰을 가립니다.
업그레이드가 거절되면(토큰 폐기 등) 브라우저는 상태 코드를 숨기고 `neverOpened: true`로 닫힙니다. 그래서 연결 전에 `verify()`로 먼저 401 `token_revoked`와 권한을 확인합니다.

## 4. ash 페이지에서 확인 [PR2 후]
`https://<ash 주소>/?manager=<매니저 URL>&kernel=<커널 ID>#<token>`을 엽니다.
- 읽은 직후 주소창에서 토큰이 사라집니다(`history.replaceState`).
- read: 셀 코드만 보이고 출력과 실행 단추가 없고, 편집할 수 없습니다. 상단에 "읽기 전용" 안내가 뜹니다.
- read+history: 출력이 보이고 실행은 못 합니다.
- read+history+execute: 실행과 인터럽트가 됩니다. 코드 수정은 못 합니다.
- 공유를 폐기하면(아래) 연결이 끊기고 "공유가 폐기되었습니다"가 보입니다.

## 5. 폐기
`curl -s -X DELETE -H "Authorization: Bearer $MASTER" $MANAGER/api/kernels/$KID/shares/$SHARE_ID` 뒤에 같은 토큰의 `verify`는 401 `token_revoked`이고 열려 있던 WebSocket은 닫힙니다.
