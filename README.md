# token-log

Claude 계정 하나를 여럿이 같이 쓰면 사용량이 한 덩어리로만 보입니다.
token-log는 **누가, 어느 프로젝트에서, 토큰을 얼마나** 썼는지를 공유 폴더 CSV에 자동으로 기록합니다.
창을 몇 주씩 켜 두어도 10분마다 쌓입니다. 대화 내용은 기록하지 않습니다.

**설치 안내 페이지: https://leekyongju2.github.io/token-log/**

## 설치

1. Node.js 확인: `node -v`
2. Claude Code 안에서 **한 줄씩 따로** 입력
   ```
   /plugin marketplace add leekyongju2/token-log
   /plugin install token-log@token-log
   ```
3. 설정 창이 뜨면 입력합니다. 나중에 바꿀 때는 `/plugin configure token-log`.

   | 항목 | 내용 | 기본값 |
   |---|---|---|
   | 내 이름 | CSV 파일 이름과 `user` 열 | (필수) |
   | 기록 폴더 | 모두가 접근하는 공유 폴더. 네트워크 드라이브, 또는 OneDrive로 동기화한 SharePoint 폴더 | `~/.claude/token-log` |
   | 중간 기록 간격(분) | 창을 켜 둔 채 쓰는 동안의 기록 간격 | 10 |

   터미널에서 한 번에 하려면:
   ```
   claude plugin install token-log@token-log --config user_name=홍길동 --config "log_dir=\\서버\공유\claude-token-log"
   ```
   값은 `~/.claude/settings.json`의 `pluginConfigs`에 저장됩니다. 예전 방식인 `env`의 `CLAUDE_USER`, `TOKEN_LOG_DIR`도 여전히 읽습니다(설정 창 값이 우선).
4. (권장) 한도 % 기록: `~/.claude/settings.json`에 상태줄 추가
   ```json
   "statusLine": { "type": "command", "command": "node ~/.claude/token-log/bin/snapshot.js" }
   ```
   이미 상태줄 스크립트가 있으면, 입력(JSON)을 읽은 다음 줄에 한 줄 추가:
   ```js
   try { require(require('os').homedir() + '/.claude/token-log/bin/snapshot.js')(input); } catch {}
   ```
5. Claude Code 재시작. 질문 하나 하고 답이 끝나면 기록 폴더에 `홍길동.csv`가 생깁니다.

## 사용

- 따로 할 일 없음. 자동 기록.
- 조회: `/token-report` 또는 "토큰 사용량 보여줘". `--since 2026-10-01`, `--user 홍길동`

## 언제 기록되나

| 시점 | 훅 | 내용 |
|---|---|---|
| 답이 끝날 때 | `Stop` (백그라운드) | 첫 답에서 한 번, 그 뒤 간격(기본 10분)마다 |
| 세션 종료 | `SessionEnd` | 남은 양 기록. 아래 참고 |
| 다음 세션 시작 | `SessionStart` (백그라운드) | 이전 세션들이 마지막 기록 뒤에 쓴 양을 따라잡아 기록 (`reason=catchup`) |

Claude Code는 플러그인의 `SessionEnd` 훅을 약 1.5초 만에 끊습니다(`timeout`을 줘도 동일, 실측).
Windows에서는 node 시작만 1초 가까이 걸려 종료 기록이 자주 잘립니다. 그래서 종료 기록은 보조이고,
빠진 양은 다음 세션을 열 때 채워집니다.

CSV 한 줄은 **직전 줄 이후에 쓴 양**(차이값)입니다. 그래서 그냥 더하면 합계가 됩니다.
`reason`: `interim`(중간), `catchup`(따라잡기), 그 외는 종료 사유. `--resume`으로 이어간 세션도 새로 쓴 양만 기록됩니다.

CSV 열: `ended_at, user, host, session_id, project, reason, models, requests, input, output, cache_write, cache_read, total, five_hour_start, five_hour_end, seven_day_start, seven_day_end, five_hour_resets_at, usd`

## 읽는 법

- `total`은 대부분 `cache_read`(단가가 가장 쌈). 부담은 `output`, `cache_write`, `usd`로 보세요.
- `usd`는 Claude Code가 계산한 API 정가 환산액. 구독 청구액 아님.
- 한도 %는 **계정 전체 값**. `/token-report`의 `5h한도+%p`는 그 구간 동안 오른 폭이라, 같은 시간에 쓴 다른 사람 몫이 섞인 추정치.

## 알아둘 것

- 답을 기다리는 시간은 늘지 않습니다(백그라운드). 종료만 최대 1.5초 늦어질 수 있습니다.
- 창을 X로 닫아도 다음에 Claude Code를 열면 따라잡습니다. 그 PC에서 다시 안 열면 마지막 간격 안쪽 사용량이 빠집니다.
- 공유 폴더가 끊겨 있던 동안의 사용량은 다음 기록 때 합쳐서 올라갑니다.
- 기록되는 것: 시각, 이름, PC 이름, 프로젝트 경로, 모델, 토큰 수, 한도 %. 프로젝트 폴더 이름은 공유 폴더 권한이 있는 사람에게 보입니다.
- `claude -p` 세션은 상태줄이 없어 한도 칸이 빕니다.
- 이름 미설정 시 `UNSET-<윈도우계정>`으로 기록됩니다.
- 로컬 상태(`~/.claude/token-log/state`, `rate`)는 45일 지나면 지웁니다.

## 구성

| 파일 | 역할 |
|---|---|
| `.claude-plugin/plugin.json` | 설정 창 항목(`userConfig`) |
| `hooks/hooks.json` | `Stop`, `SessionStart`(백그라운드), `SessionEnd` 훅 |
| `scripts/log-usage.js` | 기록(서브에이전트 포함, 차이값, 세션별 잠금, 따라잡기) |
| `scripts/snapshot.js` | 상태줄에서 한도 %와 비용 저장 |
| `scripts/report.js`, `skills/token-report` | 사용자별·일자별 집계 |
| `docs/index.html` | 설치 안내 페이지 |

## 테스트

```
node test.js
```
중복 집계, 서브에이전트 합산, CSV 이스케이프, 동시 기록, 설정 값 우선순위, 중간 기록 간격, 따라잡기, 종료와 중간 기록의 경합, 한도 % 열, 옛 헤더 교체를 확인합니다.
