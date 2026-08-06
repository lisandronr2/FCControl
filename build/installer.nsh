; Reemplaza el chequeo "¿sigue corriendo FCControl?" que trae electron-builder
; por defecto. El original solo hace un intento de cierre normal + un
; force-kill, y si el proceso sigue apareciendo (por ejemplo, porque el
; antivirus está escaneando el .exe mientras Electron termina de liberar sus
; procesos hijos) muestra "No se puede cerrar FCControl" y depende de que el
; técnico clickee Reintentar a mano.
;
; Reutiliza las macros FIND_PROCESS/KILL_PROCESS que ya trae electron-builder
; (probadas en producción) en vez de reimplementar la detección de procesos
; a mano — solo se le da mucho más presupuesto de reintentos (hasta 20,
; ≈20s) antes de mostrarle algo al técnico. Electron-builder detecta este
; archivo automáticamente por su nombre y ubicación
; (directories.buildResources, "build/" por defecto) — no hace falta
; configuración adicional en package.json.

Var fccWaitCount
Var pid

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  StrCpy $fccWaitCount 0
  StrCpy $pid "0"

  fcc_wait_loop:
    IntOp $fccWaitCount $fccWaitCount + 1

    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 != 0
      Goto fcc_not_running
    ${endIf}

    DetailPrint "Cerrando FCControl... (intento $fccWaitCount)"
    !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1
    Sleep 1000

    ${if} $fccWaitCount >= 20
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY fcc_wait_loop
      Quit
    ${endIf}
    Goto fcc_wait_loop

  fcc_not_running:
!macroend
