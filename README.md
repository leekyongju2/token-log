# token-log

공유 Claude 계정의 토큰 사용량을 **세션이 끝날 때마다 자동으로** 공유 폴더 CSV에 기록합니다.
스킬(모델이 판단해서 호출)이 아니라 **훅**으로 동작하므로, 설치만 하면 사용자가 잊어도 빠짐없이 기록됩니다.

## 구성
| 파일 | 역할 |
|---|---|
| `hooks/hooks.json` | `SessionEnd` 훅 등록 |
| `scripts/log-usage.js` | 세션 transcript(서브에이전트 포함)의 usage 합산 → `<TOKEN_LOG_DIR>/<CLAUDE_USER>.csv`에 1행 추가 |
| `scripts/report.js` · `skills/token-report` | 사용자별·일자별 집계 (`/token-report`) |

CSV 열: `ended_at, user, host, session_id, project, reason, models, requests, input, output, cache_write, cache_read, total, five_hour_start, five_hour_end, seven_day_start, seven_day_end, five_hour_resets_at, usd`

## 한도 % 기록 (상태줄 필요)
계정 한도 %(5시간·7일)와 Claude Code 자체 비용 추정(`usd`)은 **상태줄 입력에만** 들어옵니다. 상태줄이 값을 `~/.claude/token-log/rate/`에 저장하면 세션 종료 훅이 시작·끝 값을 CSV에 남깁니다.
`snapshot.js`는 첫 세션 종료 때 `~/.claude/token-log/bin/`에 복사됩니다.

- 상태줄이 없으면 `settings.json`에:
  ```json
  "statusLine": { "type": "command", "command": "node ~/.claude/token-log/bin/snapshot.js" }
  ```
- 이미 상태줄 스크립트가 있으면, 입력(JSON)을 읽은 다음 줄에 한 줄 추가:
  ```js
  try { require(require('os').homedir() + '/.claude/token-log/bin/snapshot.js')(input); } catch {}
  ```

한도 %는 **계정 전체 값**입니다. `/token-report`의 `5h한도+%p`는 세션 동안 오른 폭이라 같은 시간에 쓴 다른 사람 몫이 섞인 추정치입니다. `usd`는 API 정가 환산이지 구독 청구액이 아닙니다. 상태줄이 안 뜨는 `claude -p` 세션은 빈칸입니다.

## 팀원 설치 (1회)
1. Node.js 필요 (`node -v` 확인)
2. `~/.claude/settings.json`에 환경변수 추가
   ```json
   {
     "env": {
       "CLAUDE_USER": "홍길동",
       "TOKEN_LOG_DIR": "\\fileserver\share\claude-token-log"
     }
   }
   ```
3. 플러그인 설치
   ```
   /plugin marketplace add leekyongju2/token-log
   /plugin install token-log@token-log
   ```
4. Claude Code 재시작

## 참고
- 사람마다 파일을 따로 써서 네트워크 드라이브 동시 쓰기 충돌을 피합니다.
- `--resume`으로 이어간 세션은 누적값으로 다시 기록되며, 집계 시 세션당 최대값 1행만 셉니다.
- `CLAUDE_USER` 미설정 시 `UNSET-<윈도우계정>`, `TOKEN_LOG_DIR` 미설정 시 `~/.claude/token-log`에 기록됩니다.
- 로깅 오류가 나도 세션에는 영향이 없습니다.
- SessionEnd 훅 기본 제한시간은 1.5초라서(Windows는 node 기동만 ~1초) `hooks.json`에 `"timeout": 30`을 지정했습니다. transcript는 스트리밍으로 읽어 크기와 무관하게 메모리 ~100MB 이하입니다.

## 테스트
```
node test.js
```
중복 집계, 서브에이전트 합산, CSV 이스케이프, 동시 기록, 훅 제한시간, resume 중복을 확인합니다.
