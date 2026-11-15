# chulgeun_master API 서버

Node 20 내장 모듈만 사용하는 보호 API 서버입니다. Flutter 앱에는 VWorld 인증키를 넣지 않습니다. VWorld 키는 이 디렉터리의 로컬 `config.json`에만 직접 입력합니다.

## 실행

```bash
export DATA_GO_KR_BUS_KEY='서버에만 보관하는 키'
export UPSTREAM_RATE_PER_MINUTE=30
npm start
```

`server/config.json`의 빈 값에 VWorld 키를 직접 입력합니다. 이 파일은 `.gitignore`에 포함되어 Git에 추가되지 않습니다.

```json
{
  "odsay": {
    "apiKey": "여기에 직접 입력"
  },
  "vworld": {
    "apiKey": "여기에 직접 입력",
    "registeredDomain": "키 발급 시 등록한 도메인"
  }
}
```

ODsay 키는 `ODSAY_API_KEY` 환경변수 또는 위 서버 전용 설정에서만 읽습니다. Flutter 요청에는 좌표와 검색 옵션만 포함되고 인증키는 포함되지 않습니다. ODsay v1.8 `searchPubTransPathT`만 허용하며 좌표 검증, 요청량 제한, 30초 캐시, 동일 요청 병합, 타임아웃·5xx 재시도를 수행합니다.

VWorld는 `VWORLD_API_KEY`, `VWORLD_REGISTERED_DOMAIN`, `VWORLD_CONFIG_PATH` 환경변수도 지원합니다. 환경변수가 있으면 `config.json`보다 우선합니다. 개발은 로컬 `config.json`, 운영은 배포 환경변수 또는 Secret Manager를 사용하고 두 환경의 키·등록 도메인·쿼터를 분리합니다.

VWorld operation은 `search`, `geocode`, `reverseGeocode`입니다. 서버는 Search 2.0의 장소·도로·지번 검색과 Geocoder 2.0의 주소→좌표 변환, 현재 위치 좌표→도로명·지번 주소 변환을 수행하고, Flutter에는 키가 없는 정규화 응답만 반환합니다.

Search 2.0 응답의 `result.items`는 배열이거나 `{ "item": [...] }` 객체일 수 있습니다. 두 응답 구조를 모두 처리하며 `point.x`는 경도, `point.y`는 위도로 검증·변환합니다.

VWorld 인증키 발급 시 등록한 도메인이 있다면 `registeredDomain`에 같은 도메인을 입력합니다. 이 값은 요청의 `Referer`/`Origin` 헤더에만 사용되며 키와 함께 응답하거나 로그에 남기지 않습니다.

Flutter 앱은 `LIVE_TRANSIT_PROXY_URL`로 이 서버 주소를 사용하고 `BUS_REGION_CODE`에 조회할 10자리 법정동 코드를 전달합니다. `4686000000`은 전라남도 함평군 예시이므로 수도권 테스트에 재사용하지 않습니다.

권장 API 경로는 `POST /vworld`, `POST /route`, `POST /live`이며, 현재 서버는 경로보다 JSON 본문의 `provider`를 기준으로 분기합니다. VWorld는 `provider=vworld`, ODsay는 `provider=odsay`, 실시간 공급자는 `provider=seoul_subway`, `national_bus`, `korea_precision_bus`를 사용합니다.

Netlify에 배포할 때는 저장소 루트의 `netlify.toml`과 `netlify/functions/api.js`를 사용합니다. `/vworld`, `/route`, `/live` 요청은 공통 Function으로 전달되며, 인증키는 Netlify 환경변수에만 등록합니다. Netlify 사이트의 Deploy 설정에서 이 저장소를 연결하고 Functions가 포함된 최신 커밋을 배포한 뒤, 다음 주소를 앱의 `PROXY_BASE_URL`로 사용합니다.

    https://illustrious-bonbon-ca1054.netlify.app

배포 후 먼저 `/route`, `/vworld`, `/live`에 POST 요청이 도달하는지 확인해야 합니다. 키가 없는 경우에도 서버는 키 값을 노출하지 않고 `SERVER_CONFIGURATION_ERROR`를 반환합니다.

허용 operation은 `mst_info`, `ps_info`, `rtm_loc_info` 및 VWorld의 `search`, `geocode`, `reverseGeocode`입니다. 서버는 지역코드·페이지·검색어·주소·좌표 입력 검증, 동일 진행 중 요청 병합, 인메모리 요청량 제한, 10초 타임아웃, 5xx 1회 재시도, 인증 오류와 호출량 초과 오류 구분을 수행합니다. 요청·응답 로그에는 serviceKey나 VWorld 키를 기록하지 않습니다.

VWorld는 공식 문서의 실시간 사용 조건을 고려해 영속 응답 캐시를 두지 않고, 동일한 진행 중 요청만 병합합니다. HTTPS 운영 환경에서는 TLS 종료 프록시(Nginx/ALB 등) 뒤에 배치해야 합니다. VWorld 키가 없는 Mock 환경에서는 Flutter가 기존 Mock 경로와 UI를 계속 실행합니다.

현재 `config.json`이 비어 있으면 VWorld 요청은 `SERVER_CONFIGURATION_ERROR`로 반환됩니다. 이때 키 값 자체는 오류 응답·로그·Flutter URL에 포함하지 않습니다.

서버 장애 시 Debug에서만 Flutter의 직접 호출 fallback을 명시적으로 켤 수 있지만, 이 경우 키가 앱 빌드에 포함될 수 있습니다. 운영·배포에서는 `VWORLD_DIRECT_API_ENABLED`를 사용하지 않고 보호 API 서버만 사용합니다.

ODsay 실제 경로와 VWorld 장소·좌표는 서로 다른 역할입니다. ODsay 경로 검색 성공이 버스·지하철 실시간 도착정보 성공을 의미하지 않습니다. 서울 지하철·전국 버스 도착 API는 별도 공급자 계약과 프록시 연결이 필요하며, 초정밀버스는 `mst_info`, `ps_info`, `rtm_loc_info`를 별도로 호출합니다.
