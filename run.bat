@echo off
echo Starting application using temporary virtual environment...
REM Start the backend in a new window so that the command continues.
start "" python backend\run.py

echo Waiting for the server to start...
timeout /T 5 /NOBREAK >nul

echo Opening web browser at http://localhost:8000 ...
start "" http://localhost:8000

pause