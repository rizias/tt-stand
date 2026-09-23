# Контракт вывода и журнал вызовов

Полный состав ответа, примеры вывода в обоих режимах и устройство журнала.
Краткое описание контракта — в [README](../README.md).

## Контракт вывода

Каждый ответ, кроме текстового ответа `update`, содержит:

- `ok` и `command`;
- `data` — данные без скрытия, замены и обрезки; при заданной в профиле области
  видимости namespace в `data` попадают только данные разрешённых namespace,
  а число исключённого этой областью названо в `echo` (раздел «Область видимости»
  в [docs/configuration.md](configuration.md));
- `summary` — сводку команды;
- `echo` — что фактически выполнено;
- `incomplete` и `incompleteReasons` — полон ли результат и почему нет;
- `errorClass` и `error` — машиночитаемый класс и русское объяснение отказа.

Для логов `echo` включает выражение, период, лимит, упор в лимит, число нечитаемых
строк и порядок сервера; `field` — имя поля у `logs fields`, `null` у прочих команд;
`value` — значения, переданные `--value`, у `logs search` и `logs http`, `null`
у прочих команд. Для Kubernetes — путь и источник kubeconfig, контекст, кластер,
фактический namespace, ресурс, имя и выполненный GET-запрос. Для метрик — метод и путь,
у POST — ещё и тело запроса дословно (у GET тела нет), выражение либо селекторы,
границы периода, шаг и момент времени (или отметку, что их выбрал сервер), источник
и путь файла выражения, если оно взято из файла.

Каждый ответ — успешный и отказ — называет в `echo.ignoredFlags` флаги вызова,
которые именно эта команда не читает и которые поэтому не повлияли на результат,
в том виде, в каком они переданы (например, `--limit` у команд, которые лимита не
принимают). Общие флаги `--config`, `--profile`, `--human`, `--help` в перечень
не попадают: их читают все команды. Пустой перечень — `ignoredFlags: []`, а не
отсутствие поля. При непустом перечне рядом стоит `echo.ignoredFlagsNote` —
неизменный текст «эти флаги команда не применяет: они не повлияли на результат»;
при пустом перечне `echo.ignoredFlagsNote` — `null`. Непримени́мый флаг не отказ:
команда выполняется и отдаёт данные так, как будто флага не было — включая
флаг с некорректным значением, например нечисловой `--limit` у команды,
которая лимита не принимает: команда его не разбирает и не проверяет.

Каждый флаг вызова `logs` или `metrics` записывается в эхо сразу после разбора
аргументов командной строки, до вызова какой-либо проверяющей функции (чтения
файла выражения, проверки обязательности параметра, проверки имени метки
и прочих). Поэтому отказ, случившийся позже — при этой проверке, при выборе
профиля, чтении учётных данных или выборе источника данных, — тоже называет
в `echo` то, что успело разобраться, а не то, что успело пройти самую первую
проверку: у команд `logs` и `metrics` это `query` (или `null`, если выражение
получить не удалось), `queryFile`, `start`, `end`; у `logs fields` дополнительно
`field`; у `logs search` и `logs http` дополнительно `value`; у команд `metrics`
дополнительно `step`, `time`, `match`, `label`.

Отказ сервера, полученный по коду состояния HTTP (транспорт Grafana или хранилища
логов), сообщается кодом и телом ответа целиком: тело не отбрасывается, не сокращается
и не заменяется пересказом. При пустом теле текст так и говорит — «тело ответа
пустое»; если тело не удалось прочитать, текст называет причину.

Код завершения `0` означает, что команда отработала, включая пустой или неполный
результат. Ненулевой код означает отказ; ответ всё равно печатается в stdout.

**Пустой результат при `incomplete: true` не означает «ничего не было».**

### Примеры вывода

Успешный ответ, JSON по умолчанию. Команда `token` выбрана потому, что не обращается
ни к каким внешним системам и её результат воспроизводится дословно:

```text
tt-stand token --value eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWUsImlhdCI6MTUxNjIzOTAyMn0.KMUFsIDTnFmyG3nMiGM6H9FNFUROf3wh7SmqJp-QV30
```

```json
{
  "ok": true,
  "command": "token",
  "data": {
    "value": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWUsImlhdCI6MTUxNjIzOTAyMn0.KMUFsIDTnFmyG3nMiGM6H9FNFUROf3wh7SmqJp-QV30",
    "header": {
      "alg": "HS256",
      "typ": "JWT"
    },
    "payload": {
      "sub": "1234567890",
      "name": "John Doe",
      "admin": true,
      "iat": 1516239022
    },
    "issuedAt": {
      "claim": 1516239022,
      "readable": "2018-01-18T01:30:22.000Z"
    },
    "expiresAt": null,
    "signatureVerified": false,
    "verificationNote": "Подпись не проверялась: содержимое — утверждение из токена, а не установленная личность."
  },
  "summary": {
    "signatureVerified": false,
    "verificationNote": "Подпись не проверялась: содержимое — утверждение из токена, а не установленная личность."
  },
  "echo": {
    "command": "token",
    "query": null,
    "request": null,
    "start": null,
    "end": null,
    "limit": null,
    "limitNote": "запрос к внешней системе не выполнялся",
    "datasource": null,
    "datasourceNote": null,
    "recordsReturned": 1,
    "hitLimit": false,
    "unparsableLines": 0,
    "order": "не применимо",
    "unavailableSources": [],
    "valueVariantsGenerated": "варианты написания искомого значения не порождались — искали ровно переданное",
    "identifierPivotPerformed": "разворот «значение → идентификатор» инструментом не выполнялся",
    "journal": ".tt-stand\\profiles\\default\\journal\\2026-01-01T00-00-00-000Z-1000.json",
    "journalRun": null,
    "ignoredFlags": [],
    "ignoredFlagsNote": null
  },
  "incomplete": false,
  "incompleteReasons": [],
  "errorClass": null,
  "error": null
}
```

Тот же ответ с флагом `--human`. Поля `echo` получают русские названия, служебные
`null` не печатаются, полнота вынесена в последнюю строку:

```text
{
  "value": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWUsImlhdCI6MTUxNjIzOTAyMn0.KMUFsIDTnFmyG3nMiGM6H9FNFUROf3wh7SmqJp-QV30",
  "header": {
    "alg": "HS256",
    "typ": "JWT"
  },
  "payload": {
    "sub": "1234567890",
    "name": "John Doe",
    "admin": true,
    "iat": 1516239022
  },
  "issuedAt": {
    "claim": 1516239022,
    "readable": "2018-01-18T01:30:22.000Z"
  },
  "expiresAt": null,
  "signatureVerified": false,
  "verificationNote": "Подпись не проверялась: содержимое — утверждение из токена, а не установленная личность."
}

Что фактически выполнено:
  команда: token
  о лимите: запрос к внешней системе не выполнялся
  возвращено записей: 1
  упёрлось в лимит: false
  нечитаемых строк: 0
  порядок: не применимо
  варианты значения: варианты написания искомого значения не порождались — искали ровно переданное
  разворот: разворот «значение → идентификатор» инструментом не выполнялся
  запись журнала: .tt-stand\profiles\default\journal\2026-01-01T00-00-01-000Z-1001.json

Результат полон: да
```

Отказ печатается в тот же stdout и тем же конвертом, отличаются только `ok`,
`errorClass`, `error` и причины неполноты. Код завершения — `1`:

```text
tt-stand logs query --start -2d --end now
```

```json
{
  "ok": false,
  "command": "logs query --start -2d --end now",
  "data": null,
  "summary": null,
  "echo": {
    "command": "logs query --start -2d --end now",
    "query": null,
    "queryFile": null,
    "request": null,
    "start": "-2d",
    "end": "now",
    "limit": null,
    "limitNote": "команда не дошла до запроса",
    "datasource": null,
    "datasourceNote": null,
    "recordsReturned": 0,
    "hitLimit": false,
    "unparsableLines": 0,
    "order": "не применимо",
    "unavailableSources": [],
    "valueVariantsGenerated": "варианты написания искомого значения не порождались — искали ровно переданное",
    "identifierPivotPerformed": "разворот «значение → идентификатор» инструментом не выполнялся",
    "field": null,
    "value": null,
    "journal": ".tt-stand\\profiles\\default\\journal\\2026-01-01T00-00-02-000Z-1003.json",
    "journalRun": null,
    "ignoredFlags": [],
    "ignoredFlagsNote": null
  },
  "incomplete": true,
  "incompleteReasons": ["команда не отработала: данные не получены"],
  "errorClass": "bad_request",
  "error": "Не задан обязательный параметр --query или --query-file."
}
```

`start` и `end` в этом примере не пустые, хотя команда не дошла до запроса: они были
разобраны раньше, чем обнаружилась нехватка `--query`, и эхо отказа их не теряет.

Обязательный флаг, заданный пустой строкой (`--start ""`), не считается
отсутствующим: пустая строка уходит на сервер как дана. Класс `bad_request`
с текстом «не задан» получает только флаг, которого во входных данных не было
вовсе.

Если запрос успел вернуть часть записей и оборвался, они остаются в `data`,
`limitNote` становится «запрос прерван до конца», а причина неполноты прямо
говорит, что в ответе только пришедшее до обрыва.

### Ответ команд метрик

`data` — поле `data` ответа сервера без изменений, после фильтра области, если она
задана: ряды `metrics query` и `metrics instant` в порядке сервера, перечни
`metrics labels` и `metrics series` как их отдал сервер.

`summary`:

- `seriesCount`, `pointCount` — для `metrics query` и `metrics instant`: у ответа
  вида `matrix` `pointCount` считает точки полей `values` и `histograms` каждого
  ряда, у ответа вида `vector` — по одной точке на ряд (обе команды могут
  вернуть любой из этих видов — правило зависит от вида ответа, а не от того,
  какая это команда);
- `valueCount` — для `metrics labels` и `metrics series`;
- `server` — все прочие поля ответа сервера, кроме `status` и `data`, без изменений.

`echo` дополнительно к общему контракту называет: `request` — метод и путь
программного интерфейса сервера; у POST следом идёт тело запроса дословно,
в том же виде, что у команд логов; у GET тела нет — непустая строка параметров
дописывается к пути через `?`, а если параметров нет, путь идёт без неё;
`query`, `queryFile`, `match`, `label`, `start`, `end`, `step`,
`time` — как переданы пользователем, `null`, если не заданы; `serverChosen` — имена
не заданных параметров, значения которых выбрал сервер; `datasource`,
`datasourceType`, `datasourceUid`, `datasourceNote` — источник, через который ушёл
запрос; `recordsReturned` — число выведенных рядов или значений; `recordsOutOfScope`,
`seriesWithoutNamespace`, `valuesHiddenByScope` — сколько скрыто областью видимости,
по каждой группе отдельно; `limit: null` с `limitNote`: «у команд метрик лимита нет —
инструмент своего не подставляет»; `order`: «порядок рядов и значений — как отдал
сервер; инструмент их не переставляет».

Пример `metrics query` — ряд использования CPU по подам вымышленного namespace
`example-ns`:

```text
tt-stand metrics query --query 'sum(rate(container_cpu_usage_seconds_total{namespace="example-ns"}[5m])) by (namespace, pod)' --start 2026-01-15T00:00:00Z --end 2026-01-15T01:00:00Z --step 5m
```

```json
{
  "ok": true,
  "command": "metrics query",
  "data": {
    "resultType": "matrix",
    "result": [
      {
        "metric": { "pod": "example-api-5f7c9d8b6-abcde", "namespace": "example-ns" },
        "values": [
          [1768435200, "0.12"],
          [1768435500, "0.14"]
        ]
      }
    ]
  },
  "summary": {
    "seriesCount": 1,
    "pointCount": 2,
    "server": {}
  },
  "echo": {
    "command": "metrics query",
    "query": "sum(rate(container_cpu_usage_seconds_total{namespace=\"example-ns\"}[5m])) by (namespace, pod)",
    "queryFile": null,
    "request": "POST /api/v1/query_range query=sum%28rate%28container_cpu_usage_seconds_total%7Bnamespace%3D%22example-ns%22%7D%5B5m%5D%29%29+by+%28namespace%2C+pod%29&start=2026-01-15T00%3A00%3A00Z&end=2026-01-15T01%3A00%3A00Z&step=5m",
    "start": "2026-01-15T00:00:00Z",
    "end": "2026-01-15T01:00:00Z",
    "limit": null,
    "limitNote": "у команд метрик лимита нет — инструмент своего не подставляет",
    "datasource": "Prometheus",
    "datasourceNote": "источник выбран автоматически: единственный подходящий по типу",
    "recordsReturned": 1,
    "hitLimit": false,
    "unparsableLines": 0,
    "order": "порядок рядов и значений — как отдал сервер; инструмент их не переставляет",
    "unavailableSources": [],
    "valueVariantsGenerated": "варианты написания искомого значения не порождались — искали ровно переданное",
    "identifierPivotPerformed": "разворот «значение → идентификатор» инструментом не выполнялся",
    "profile": "default",
    "namespaceScope": null,
    "recordsOutOfScope": 0,
    "match": null,
    "label": null,
    "step": "5m",
    "time": null,
    "serverChosen": [],
    "datasourceType": "prometheus",
    "datasourceUid": "00000000-0000-0000-0000-000000000000",
    "seriesWithoutNamespace": 0,
    "valuesHiddenByScope": 0,
    "journal": ".tt-stand\\profiles\\default\\journal\\2026-01-15T00-01-00-000Z-1002.json",
    "journalRun": null,
    "ignoredFlags": [],
    "ignoredFlagsNote": null
  },
  "incomplete": false,
  "incompleteReasons": [],
  "errorClass": null,
  "error": null
}
```

Разделитель в пути `echo.journal` — системный: на Windows `\`, на macOS и Linux `/`;
в примерах этого документа показан вид Windows.

### Неполнота и отказ метрик

Ответ помечается неполным, если сервер сам сообщил об этом: полем `isPartial: true`
либо непустым полем `warnings` — тексты предупреждений выводятся дословно. Отдельные
причины неполноты добавляет фильтр области видимости: часть рядов исключена, потому
что их `namespace` вне области, часть рядов исключена, потому что у них нет метки
`namespace` вообще, часть значений метки скрыта, потому что при заданной области
их принадлежность namespace не определяется. Иных причин неполноты из содержимого
ответа инструмент не выводит.

| Причина | Текст |
|---|---|
| `serverPartial` | сервер пометил ответ частичным (isPartial) |
| `serverWarnings` | сервер вернул предупреждения: тексты — в `summary.server.warnings` |
| `seriesOutOfScope` | часть рядов не попала в ответ: их namespace вне области видимости профиля — это не то же самое, что отсутствие данных |
| `seriesWithoutNamespace` | ряды без метки namespace не показаны: их принадлежность области не проверить — группировка `by (namespace)` в выражении даст проверяемые ряды |
| `labelValuesOutOfScope` | часть значений метки namespace не попала в ответ: они вне области видимости профиля — это не то же самое, что отсутствие данных |
| `labelValuesHiddenByScope` | значения метки не показаны: при заданной области их принадлежность namespace не определяется — `metrics series` показывает значения вместе с namespace. В самом ответе к тексту дописывается число скрытых значений: « (скрыто: N)» |
| `responseShapeHiddenByScope` | ответ сервера неожиданного вида показан не целиком: при заданной области принадлежность namespace его частей не проверить |

Значения метки `namespace`, исключённые областью (`metrics labels --label namespace`),
и ряды, исключённые областью, — разные причины неполноты: `labelValuesOutOfScope`
для первых, `seriesOutOfScope` для вторых, хотя оба случая используют поле эха
`recordsOutOfScope`.

Причина `responseShapeHiddenByScope` объединяет все случаи, когда при заданной
области принадлежность данных namespace нельзя проверить, и поэтому эти данные
не выводятся:

- у `query`/`instant` `data` — не объект с известным `resultType`
  (`matrix`, `vector`, `scalar`, `string`), либо объект с `resultType`
  `matrix`/`vector`, у которого `result` не массив, — `data: null` целиком;
- у `series` или перечня значений метки сам `data` — не массив — `data: null`
  целиком;
- отдельный элемент `result` (у вида `matrix`/`vector`) или элемент `series`,
  который не является объектом, — не выводится, остальные элементы
  фильтруются по области как обычно; `data` при этом не становится `null`;
- отдельный элемент перечня значений метки `namespace`, который не является
  строкой, — не выводится тем же способом, остальные значения фильтруются как
  обычно;
- у опознанного `data` `query`/`instant` (`resultType` известен и, если это
  `matrix`/`vector`, `result` — массив) есть поля, кроме `resultType`
  и `result`, — эти поля не выводятся, а `data` в ответе сохраняет только
  `resultType` и отфильтрованный `result` (у `scalar`/`string` — `result: null`).

Показывать данные, принадлежность которых области не проверена, опаснее, чем
назвать причину неполноты и не показать именно эту часть ответа.

Ответ сервера метрик с полем `status: "error"` завершает команду отказом с классом
`metrics_query_rejected`; этот класс общий для ошибки в выражении и для превышения
предела точек или рядов, заданного сервером, — причину называет текст сервера,
инструмент её не угадывает:

```text
tt-stand metrics query --query 'sum(rate(container_cpu_usage_seconds_total[5m])) by (pod)' --start 2026-01-01T00:00:00Z --end 2026-02-01T00:00:00Z --step 1s
```

```json
{
  "ok": false,
  "command": "metrics query --query sum(rate(container_cpu_usage_seconds_total[5m])) by (pod) --start 2026-01-01T00:00:00Z --end 2026-02-01T00:00:00Z --step 1s",
  "data": null,
  "summary": null,
  "echo": {
    "command": "metrics query --query sum(rate(container_cpu_usage_seconds_total[5m])) by (pod) --start 2026-01-01T00:00:00Z --end 2026-02-01T00:00:00Z --step 1s",
    "query": "sum(rate(container_cpu_usage_seconds_total[5m])) by (pod)",
    "queryFile": null,
    "start": "2026-01-01T00:00:00Z",
    "end": "2026-02-01T00:00:00Z",
    "step": "1s",
    "order": "не применимо",
    "...": "прочие поля — как их успел разобрать разбор аргументов до отказа: datasource, profile, namespaceScope, request и другие"
  },
  "incomplete": true,
  "incompleteReasons": ["команда не отработала: данные не получены"],
  "errorClass": "metrics_query_rejected",
  "error": "Сервер метрик отклонил запрос: HTTP 422, errorType: bad_data, error: query processing would load too many samples into memory; тело ответа: {\"status\":\"error\",\"errorType\":\"bad_data\",\"error\":\"query processing would load too many samples into memory\"}"
}
```

У отказа `echo.command` — вся строка аргументов вызова целиком (как у любого
отказа, а не только у `metrics_query_rejected`), а не короткое имя команды, как
в успешном ответе. `echo.order` — «не применимо»: строк в ответе нет. Эхо не
совпадает с эхом успешного ответа целиком: оно называет только то, что разбор
аргументов и последующие шаги успели определить до отказа, — для
`metrics_query_rejected` запрос к серверу уже ушёл, поэтому `echo.request`
тоже присутствует.

Отказ без поля `status: "error"` в теле разбирается общим путём отказов транспорта
Grafana: коды 401 и 403 дают класс `auth_failed`, прочие — `upstream_error`, таймаут
инструмента — `timeout_client`; текст называет код состояния и содержит тело ответа
сервера целиком, как в требовании о таймауте и отказах возможности `logs-access`.
Коды 401 и 403 проверяются раньше разбора тела ответа: если сервер вернул `status:
"error"`, но код состояния HTTP — 401 или 403, класс всё равно `auth_failed`, а не
`metrics_query_rejected` — отказ в доступе не выдаётся за ошибку запроса. Если поле
`errorType` или `error` отсутствует в теле, текст класса `metrics_query_rejected`
называет его словом «отсутствует», а не подставляет `undefined`; значение
не строкового типа выводится в тексте своим представлением JSON. После значения
поля `error` текст класса `metrics_query_rejected` дополнительно дописывает тело
ответа целиком, отделённое «; тело ответа: », чтобы пояснение сервера в других
полях тела не терялось.

Независимо от того, задана ли область видимости, тело ответа с кодом 2xx, которое
не разобралось в объект с полем `status`, равным `success` — не образующее
корректный JSON, разобравшееся в JSON-массив, разобравшееся в значение не объектом
или в объект без такого поля либо с иным его значением, — класс `upstream_error`,
текст содержит тело ответа целиком: такое тело не конверт API Prometheus, и
инструмент не угадывает в нём данные.

Источник метрик, для которого не нашлось источника Grafana подходящего типа, даёт
класс `datasource_not_found` — тот же текст, что и для источника логов: перечень
допустимых типов и указание настройки, которой источник задаётся явно
(`grafana.metricsDatasourceUid` для метрик, `grafana.datasourceUid` для логов).

## Журнал вызовов

У каждого профиля свой журнал: умолчание — каталог `journal` внутри каталога
профиля, то есть `~/.tt-stand/profiles/<имя>/journal`. Путь переопределяется полем
`journal.directory` в `profiles/<имя>/profile.json` действующего профиля:

```json
{
  "journal": {
    "directory": "~/.tt-stand/profiles/branch-b/journal-custom"
  }
}
```

Журнал сделан отдельным для каждого профиля, а не общим: запись хранит ответ
команды целиком, то есть настоящие строки логов того контура, к которому
обращались. Если журналы всех профилей лежат в одной куче, данные одного филиала
перемешаны с данными другого. Когда журнал лежит внутри каталога профиля, этот
каталог можно целиком удалить или передать другому человеку — чужих данных
в нём не окажется.

Каждый вызов, кроме `update`, пишется отдельным файлом. Файл содержит время, вызов целиком и ответ
целиком — как он был отдан, без сокращений. Отказавшие команды попадают туда
наравне с успешными.

Файл на вызов, а не общий файл, потому что агентов может работать несколько сразу:
два процесса никогда не пишут в один файл, поэтому портиться нечему. Имя файла
начинается со времени вызова, поэтому обычная сортировка по имени даёт порядок
выполнения.

Каждая запись называет происхождение: идентификатор запустившего процесса и метку
расследования из переменной `TT_STAND_RUN`, если она задана. Метка отделяет вызовы
одного расследования от чужих:

```bash
TT_STAND_RUN=разбор-инцидента tt-stand logs search --value "+70000000000" --start -2d --end now
```

Последовательность вызовов одного расследования собирается из каталога журнала
профиля, которым вели расследование (здесь — `default`):

```bash
node -e "const fs=require('fs'),d=require('os').homedir()+'/.tt-stand/profiles/default/journal';for(const f of fs.readdirSync(d).sort()){const e=JSON.parse(fs.readFileSync(d+'/'+f,'utf8'));if(e.origin.run===process.argv[1])console.log(e.invocation.join(' '))}" разбор-инцидента
```

Записи не удаляются: сколько их хранить, решает владелец. Инструмент их не чистит
и число не ограничивает.

Куда легла запись, показывает поле `journal` в эхо ответа, метку — `journalRun`.
Если записать не удалось, в `journal` стоит причина, а команда всё равно отрабатывает
и отдаёт ответ.
