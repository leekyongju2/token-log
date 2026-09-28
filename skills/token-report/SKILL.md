---
name: token-report
description: 공유 계정의 토큰 사용량을 사용자별·일자별로 집계해 보여준다. "토큰 사용량", "누가 얼마나 썼어", "token report", "/token-report" 요청 시 사용.
allowed-tools: Bash(node:*)
---

# token-report

훅이 `<기록 폴더>/<이름>.csv`에 쌓은 기록을 집계한다. 한 줄은 직전 줄 이후 사용량이라 그냥 더한다.

1. 아래 명령을 실행한다. 사용자가 기간이나 사람을 지정하면 옵션을 붙인다.
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/report.js" --dir "${user_config.log_dir}" [--since YYYY-MM-DD] [--user 이름]
   ```
2. 출력된 표를 그대로 보여주고, 사용량 상위 사용자와 급증한 날짜를 한두 줄로 짚는다.
3. `UNSET-` 으로 시작하는 사용자가 있으면 그 PC에서 이름 설정이 빠졌다고 알려준다. 설정은 `/plugin configure token-log`.

참고: `total`은 input + output + cache_write + cache_read 합계다. 요금 부담은 output과 cache_write가 크고 cache_read는 작다.
