# Контракт вывода и журнал вызовов

Полный состав ответа, примеры вывода в обоих режимах и устройство журнала.
Краткое описание контракта — в [README](../README.md).

## Контракт вывода

Каждый ответ, кроме текстового ответа `update`, содержит:

- `ok` и `command`;
- `data` — данные без скрытия, замены и обрезки;
- `summary` — сводку команды;
- `echo` — что фактически выполнено;
- `incomplete` и `incompleteReasons` — полон ли результат и почему нет;
- `errorClass` и `error` — машиночитаемый класс и русское объяснение отказа.

Для логов `echo` включает выражение, период, лимит, упор в лимит, число нечитаемых
строк и порядок сервера. Для Kubernetes — путь и источник kubeconfig, контекст, кластер,
фактический namespace, ресурс, имя и выполненный GET-запрос.

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
    "journalRun": null
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
    "request": null,
    "start": null,
    "end": null,
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
    "identifierPivotPerformed": "разворот «значение → идентификатор» инструментом не выполнялся"
  },
  "incomplete": true,
  "incompleteReasons": ["команда не отработала: данные не получены"],
  "errorClass": "bad_request",
  "error": "Не задан обязательный параметр --query."
}
```

Если запрос успел вернуть часть записей и оборвался, они остаются в `data`,
`limitNote` становится «запрос прерван до конца», а причина неполноты прямо
говорит, что в ответе только пришедшее до обрыва.

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
