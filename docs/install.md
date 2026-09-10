# Установка tt-stand

Требования, обёртки npm и политика выполнения сценариев в PowerShell.
Краткий порядок — в [README](../README.md).

## Установка

```text
npm install -g @rizias/tt-stand
```

Требуется Node.js 22.19.0 или выше. Поддерживаются Windows, Linux и macOS, PowerShell и
POSIX-совместимые оболочки. Kubernetes-клиент встроен; установленный `kubectl` не нужен.

### PowerShell и политика выполнения сценариев

npm создаёт три обёртки: `tt-stand` для sh, `tt-stand.cmd` и `tt-stand.ps1`. При политике
выполнения `Restricted` (умолчание Windows) PowerShell отказывается запускать `.ps1`
и сообщает, что выполнение сценариев отключено. Обёртка `.cmd` политикой не ограничена,
поэтому достаточно вызвать её явно:

```text
tt-stand.cmd logs query --query "*" --start -1h --end now
```

Либо один раз разрешить сценарии для своей учётной записи — политику машины это
не меняет:

```text
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Текущее состояние показывает `Get-ExecutionPolicy -List`.
