; Reemplaza el chequeo "¿sigue corriendo FCControl?" que trae electron-builder
; por defecto. El original solo hace un intento de cierre normal + un
; force-kill, y si el proceso sigue apareciendo (por ejemplo, porque el
; antivirus está escaneando el .exe mientras Electron termina de liberar sus
; procesos hijos) muestra "No se puede cerrar FCControl" y depende de que el
; técnico clickee Reintentar a mano — confirmado en la práctica que a veces
; hacen falta varios reintentos hasta que se libera solo.
;
; Esta versión hace lo mismo automáticamente: fuerza el cierre y reintenta
; hasta 15 veces (≈15-20s) antes de mostrarle algo al técnico. Electron
; builder detecta este archivo automáticamente por su nombre y ubicación
; (directories.buildResources, "build/" por defecto) — no hace falta
; configuración adicional en package.json.

Var fccWaitCount

!macro customCheckAppRunning
  StrCpy $fccWaitCount 0

  fcc_wait_loop:
    IntOp $fccWaitCount $fccWaitCount + 1

    nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop $0
    ${if} $0 != 0
      Goto fcc_not_running
    ${endIf}

    DetailPrint "Cerrando FCControl..."
    nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
    Pop $0
    Sleep 1000

    ${if} $fccWaitCount >= 15
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY fcc_wait_loop
      Quit
    ${endIf}
    Goto fcc_wait_loop

  fcc_not_running:
!macroend
