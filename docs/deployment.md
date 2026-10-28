# 배포와 차등 업데이트

새로 설치할 때는 **완성 ZIP**, 기존 설치를 갱신할 때는 **해당 버전용 업데이트 ZIP**을 사용합니다. GitHub의 **Code → Download ZIP**은 소스 코드라 실행할 수 없습니다.

| 파일 | 용도 |
|---|---|
| `pi-kit-win-x64.zip` | 실행 파일과 의존성을 모두 담은 완성 배포본 |
| `pi-kit-update-from-<기준버전>-win-x64.zip` | 기준 버전에서 바뀐 파일과 삭제 목록을 담은 업데이트 |
| `*.zip.sha256` | ZIP이 손상되지 않았는지 확인하는 해시 |
| `manifest-win-x64.json` | 배포 파일별 해시 목록. 다음 업데이트를 만들 때 비교 기준으로 사용 |

업데이트 ZIP을 만들려면 **새 완성 ZIP이 먼저 필요**합니다. 폐쇄망 PC에는 업데이트 ZIP만 옮기면 되며, 그곳에서 빌드하거나 npm/pip 설치를 할 필요는 없습니다.

## 자동 배포

`v*` 태그를 push하면 [GitHub Actions](../.github/workflows/offline.yml)가 완성 ZIP을 만들고 Windows에서 검증합니다. 이어 이전 Release와 비교해 업데이트 ZIP을 만들고, 적용 테스트를 거친 뒤 두 ZIP과 해시·manifest를 Release에 올립니다. 이전 Release가 없으면 업데이트 ZIP은 만들지 않습니다.

Release 첨부 파일은 Actions 아티팩트 저장 공간을 사용하지 않습니다. 다만 결제·지출 한도 때문에 **Actions 실행 자체가 막혔다면** 자동 배포도 멈춥니다. 이때는 아래처럼 Windows PC에서 만들고 검증한 파일을 수동으로 게시할 수 있습니다.

## Windows에서 업데이트 ZIP 만들기

### 1. 새 배포본과 기존 배포본 준비

[Windows 로컬 패키징 안내](development.md)에 따라 새 완성 ZIP을 만듭니다.

```text
dist/pi-kit-win-x64.zip
```

비교 기준으로는 **현재 설치된 버전의 원본 완성 ZIP**이나 그 Release의 `manifest-win-x64.json`을 준비합니다. 새 ZIP과 기존 ZIP은 다른 경로에 보관하세요.

manifest는 원본 그대로 사용해야 합니다. 내용을 고치거나 파일 목록을 새로 만들면, 설치된 버전과 해시가 달라 업데이트가 거부됩니다.

### 2. 변경된 파일 묶기

기존 설치가 `v1.7.2`라면 저장소 루트의 PowerShell에서 다음을 실행합니다. `--base` 경로는 실제 받은 기존 ZIP 경로로 바꾸세요.

```powershell
py -3.13 .github/tools/make-update.py `
  --new-zip .\dist\pi-kit-win-x64.zip `
  --base C:\Downloads\pi-kit-v1.7.2-win-x64.zip `
  --base-version v1.7.2 `
  --output-dir .\dist

if ($LASTEXITCODE) { throw '업데이트 ZIP 생성 실패' }
```

- `--base`: 기존 완성 ZIP 또는 원본 manifest 경로
- `--base-version`: 업데이트를 적용할 **기존 버전** 이름
- 새 버전 이름: 새 완성 ZIP의 `manifest.json`에서 읽음. 로컬 빌드 때 설정한 `RELEASE_VERSION` 사용

결과는 다음과 같습니다.

```text
dist/pi-kit-update-from-v1.7.2-win-x64.zip
dist/pi-kit-update-from-v1.7.2-win-x64.zip.sha256
dist/manifest-win-x64.json
```

런타임이나 외부 패키지가 바뀌면 그 파일도 포함되므로 업데이트 ZIP이 커질 수 있습니다. `--base`를 빼면 manifest만 만들고 업데이트 ZIP은 만들지 않습니다.

### 3. 배포 전 확인

ZIP 생성 성공과 실제 동작 확인은 별개입니다.

- 새 완성 ZIP을 다른 경로에 풀고 [로컬 검증 절차](development.md)를 실행합니다. 파일 해시, 확장 로딩, 토큰 조회, Edge, 언어 서버를 확인합니다.
- **기존 버전의 복사본**에도 업데이트를 적용해 봅니다. 실제 API 키나 업무 데이터가 없는 테스트 환경을 사용하세요.
- 변경 기능과 설정을 확인합니다. 업데이트는 설정을 자동 병합하지 않으므로, 변경 목록에 있는 설정 파일은 교체될 수 있습니다.

`setup.ps1`을 실행하면 **PC의 시스템 PATH와 환경 변수가 테스트한 폴더를 가리키도록 바뀝니다.** 일상 개발 PC에서 적용 테스트를 할 때는 이 점에 주의하세요.

CI의 적용 테스트는 `tests/update-overlay.py`와 워크플로의 `Verify overlay update applies with setup.ps1` 단계에 있습니다. 로컬 테스트만 했다면 전체 CI를 통과한 것으로 표시하지 마세요.

## 폐쇄망 PC에 적용하기

1. pi와 동봉 도구를 사용하는 프로세스를 종료합니다.
2. **기존 설치 폴더 전체를 백업**합니다. API 설정·인증 정보·세션·직접 바꾼 설정도 보존하세요.
3. `Get-FileHash -Algorithm SHA256 <업데이트 ZIP 경로>` 결과가 `.sha256` 파일의 값과 같은지 확인합니다.
4. ZIP 안의 `pi-kit` 폴더를 기존 설치 폴더와 합칩니다. 기존 `setup.ps1` 옆에 `update`가 생겨야 합니다. 폴더를 이중으로 넣지 마세요. v0.1.x로 설치해 폴더 이름이 `pi-offline-kit`여도 이름을 바꾸지 말고 그 폴더에 합칩니다.

   ```text
   기존설치폴더/
     setup.ps1
     manifest.json
     scripts/setup.ps1
     update/
       update.json
       manifest.json
       files/
   ```

5. 관리자 PowerShell에서 기존 설치 폴더의 `setup.ps1`을 실행합니다.

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\기존설치폴더\setup.ps1"
   if ($LASTEXITCODE) { throw '업데이트 또는 설정 실패' }
   ```

6. 새 터미널에서 pi를 실행합니다. 사내 API·Redis·MCP 설정을 확인하고 HUD, `/tokens`, `/mcp`, 필요한 언어 서버가 동작하는지 살펴보세요. Edge 연결은 브라우저에서도 허용해야 합니다.

**압축만 풀어서는 적용되지 않습니다.** `setup.ps1`이 기존 버전과 업데이트 파일의 해시를 확인한 뒤 파일을 교체·삭제합니다. 기준 버전이 다르다는 오류가 나면 manifest를 고치지 말고 맞는 업데이트 ZIP을 받으세요.

기존 `scripts/setup.ps1`이 `update/update.json` 처리를 지원하지 않는 구버전이라면 새 완성 ZIP을 별도 폴더에 설치합니다. 소스 ZIP이나 새 완성 ZIP을 기존 설치에 통째로 덮어쓰지 마세요. 일반 설치 절차는 [설치와 설정](installation.md)을 참고하세요.

## GitHub Release에 수동으로 올리기

인터넷 가능한 PC에서 저장소의 **Releases → Draft a new release**를 엽니다.

1. 새 버전 태그와 대상 커밋을 선택합니다. 태그 이름은 완성 ZIP의 버전과 맞추고, 테스트 배포라면 **Set as a pre-release**를 선택합니다.
2. 완성 ZIP, 업데이트 ZIP, 각각의 `.sha256`, `manifest-win-x64.json`을 첨부합니다.
3. 본문에 **대상 커밋, 업데이트 기준 버전, 실제로 확인한 테스트, CI 실행 여부**를 적습니다.
4. 업로드가 끝나면 게시합니다.

파일을 수동으로 첨부하는 데 Actions 실행은 필요하지 않습니다. 다만 `v*` 태그를 만들면 자동 워크플로가 시작될 수 있습니다. 나중에 Actions를 재실행할 때는 이미 만든 Release와 자동 게시가 충돌하지 않는지 먼저 확인하세요.
