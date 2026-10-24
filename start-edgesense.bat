@echo off
set ROOT=%~dp0

start "EdgeSense Backend" cmd /k "cd /d %ROOT%backend && pip install -r requirements.txt && python -m uvicorn app.main:app --reload --port 8000"
start "EdgeSense Frontend" cmd /k "cd /d %ROOT%frontend && npm install && npm run dev"
