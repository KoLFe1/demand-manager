@echo off
rem Demand Manager - abre o aplicativo no navegador padrao usando o servidor local (tools\devserver.py).
rem Basta dar dois cliques neste arquivo. Funciona mesmo que a pasta tenha espacos no nome.
chcp 65001 >nul
title Demand Manager
cd /d "%~dp0"

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY (
  where py >nul 2>nul && set "PY=py -3"
)
if not defined PY goto :sem_python

echo.
echo   Demand Manager
echo   --------------
echo   O aplicativo vai abrir no navegador em http://127.0.0.1:8765/
echo.
echo   Mantenha esta janela aberta enquanto estiver usando o aplicativo.
echo   Fechar esta janela (ou apertar Ctrl+C) encerra o aplicativo.
echo   Os seus dados continuam guardados no navegador.
echo.

%PY% "tools\devserver.py" --port 8765 --open
if errorlevel 1 goto :falhou
goto :fim

:sem_python
echo.
echo   Não encontrei o Python neste computador.
echo   Instale o Python 3 (https://www.python.org/downloads/) marcando a opção
echo   "Add python.exe to PATH" e abra este arquivo de novo.
echo.
pause
exit /b 1

:falhou
echo.
echo   Não foi possível iniciar o aplicativo.
echo   A porta 8765 pode estar em uso: talvez o Demand Manager já esteja aberto em outra janela.
echo.
pause
exit /b 1

:fim
exit /b 0
