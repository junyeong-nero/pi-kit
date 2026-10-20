# 토큰 사용량 조회

배포본에는 MIT 라이선스의 [`@tian.zuo/pi-usage`](https://github.com/TianZuo555/pi-extensions/tree/main/packages/pi-usage) 0.5.0이 포함됩니다. GitHub Actions가 버전·해시를 고정한 의존성과 라이선스를 준비하므로, 대상 PC에서 npm 설치나 인터넷 다운로드를 할 필요가 없습니다.

## 사용법

pi 대화형 화면에서 `/tokens`를 입력합니다.

| 키 | 기능 |
|---|---|
| `←` / `→`, `1`~`4` | 오늘 / 최근 7일 / 최근 30일 / 이번 달 전환 |
| `Tab` | 토큰 수 / 비용 그래프 전환 |
| `↑` / `↓` | 모델별 순위 스크롤 |
| `r` | 세션 기록 다시 읽기 |
| `Esc` / `q` / `Enter` | 닫기 |

오늘은 시간별, 나머지 기간은 일별 그래프입니다. 날짜 경계는 실행 PC의 로컬 시간대를 따릅니다. **최근 7일·30일은 이동 기간이며, 달력 기준 주별·월별 과거 기록을 나란히 비교하는 기능은 아닙니다.** 이번 달은 월초부터 현재까지입니다.

## 사내·로컬 모델 지원 조건

`/tokens`는 모델 서버나 외부 계정의 사용량 API를 조회하지 않고, `PI_CODING_AGENT_DIR/sessions`의 pi 세션 JSONL을 읽습니다. 이 배포본의 정상 설정에서는 `<배포 폴더>/config/sessions`입니다. 따라서 모델이 로컬에서 실행되는지, 사내 서버인지, 외부 서비스인지는 집계 조건이 아닙니다.

필요한 조건은 **API가 토큰 사용량을 반환하고 pi가 이를 세션에 저장하는 것**입니다. 기본 설정 예시인 `corp` provider / `openai-completions`에서는 pi가 `stream_options: { "include_usage": true }`를 요청합니다. 서버는 스트리밍 응답에 다음과 같은 usage 청크를 반환해야 합니다.

```text
data: {"id":"example","object":"chat.completion.chunk","model":"internal-model","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":10}}}

data: [DONE]
```

이 예시는 pi에서 일반 입력 90, 캐시 읽기 10, 출력 20, 총 120토큰으로 정규화됩니다. 캐시 상세 정보가 없으면 입력·출력 합계는 집계할 수 있어도 캐시 사용량은 구분할 수 없습니다.

### 0토큰으로 보일 때

- 서버가 응답을 생성해도 `usage`를 보내지 않으면 pi에는 0토큰으로 남을 수 있습니다. **0토큰 표시가 실제로 토큰을 쓰지 않았다는 뜻은 아닙니다.** 이 확장은 누락된 사용량을 토크나이저로 추정하지 않습니다.
- 스트리밍을 사용하는 pi에는 일반 JSON 응답에만 usage가 있고 스트리밍 응답에는 없는 서버도 문제가 됩니다. 서버 담당자에게 스트리밍 usage 지원을 확인하세요.
- 서버가 `stream_options`를 거절하면 OpenAI 호환 설정 조정이 필요할 수 있습니다. `supportsUsageInStreaming: false`로 요청 필드를 끄는 것만으로 누락된 사용량이 생기지는 않습니다.
- `--no-session`으로 실행한 기록이나 지운 세션은 나중에 집계할 수 없습니다. 다른 PC의 세션은 자동으로 합쳐지지 않습니다.
- upstream 0.5.0은 스캔 속도를 위해 파일명 시작 날짜가 조회 시작보다 7일 넘게 오래된 세션 파일을 건너뜁니다. 오랫동안 같은 세션을 유지하면 최근 요청이 일부 누락될 수 있습니다. 비표준 파일명에는 이 최적화를 적용하지 않습니다.

### 비용과 잔여량

`config/models.example.json`의 단가는 모두 0입니다. 이 설정에서 보이는 `$0`는 무료이거나 사내 과금이 없다는 뜻이 아니라, **단가를 0으로 기록했다는 뜻**입니다. 비용까지 보려면 모델 설정에 실제 단가를 넣어야 합니다. 이미 기록된 과거 비용은 설정 변경으로 다시 계산되지 않습니다.

`/usage`는 Codex·Copilot 등 외부 서비스의 계정 잔여량 조회 기능입니다. 사내 모델의 토큰 통계에는 **`/tokens`를 사용하세요.** `corp` provider의 시작·모델 선택·턴 시작 이벤트는 외부 provider 조회를 하지 않지만, `/usage`를 직접 실행하거나 외부 provider로 바꾸면 해당 확장의 외부 조회 기능이 실행될 수 있습니다. `corp`를 유지하고 사내 API 키를 외부 서비스용 인증 설정에 넣지 마세요.

## 검증

`tests/usage-tracker.test.mjs`는 실제 사내 서버 대신 로컬 HTTP OpenAI 호환 서버를 띄워 다음 경로를 검증합니다.

1. 사용자 정의 `corp` provider가 SSE로 usage를 반환합니다.
2. pi의 실제 OpenAI 호환 어댑터가 이를 정규화합니다.
3. 실제 `SessionManager`가 세션 JSONL에 기록합니다.
4. 배포 대상인 upstream 확장의 실제 `/tokens` 명령이 오늘·7일·30일·이번 달 합계를 읽습니다.

캐시 포함 120토큰 집계, 복제된 세션의 중복 제거, 0단가 비용, usage 누락 시 0토큰, `corp` 이벤트와 `/tokens` 실행 중 fetch 호출 0회를 검사합니다. 테스트를 실행할 때는 CI가 준비하는 `vendor/extensions` 의존성이 있어야 합니다.

```text
npm run test:usage
```

Windows CI는 ZIP을 공백·한글 경로에 푼 뒤 그 안의 확장을 대상으로 같은 테스트를 실행합니다. 기존 standalone 검증도 새 확장을 포함한 패키지 전체를 로드합니다. **테스트 서버 통과는 실제 사내 API의 usage 응답을 보장하지 않습니다.** 배포 전 사내 서버에서 한 차례 요청해 토큰이 증가하는지 최종 확인해야 합니다.
