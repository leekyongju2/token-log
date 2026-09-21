# token-log

공유 Claude 계정의 토큰 사용량을 **세션이 끝날 때마다 자동으로** 공유 폴더 CSV에 기록합니다.
스킬(모델이 판단해서 호출)이 아니라 **훅**으로 동작하므로, 설치만 하면 사용자가 잊어도 빠짐없이 기록됩니다.

## 구성
| 파일 | 역할 |
|---|---|
| `hooks/hooks.json` | `SessionEnd` 훅 등록 |
| `scripts/log-usage.js` | 세션 transcript(서브에이전트 포함)의 usage 합산 → `<TOKEN_LOG_DIR>/<CLAUDE_USER>.csv`에 1행 추가 |
| `scripts/report.js` · `skills/token-report` | 사용자별·일자별 집계 (`/token-report`) |

CSV 열: `ended_at, user, host, session_id, project, reason, models, requests, input, output, cache_write, cache_read, total`

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
