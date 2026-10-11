@echo off
chcp 65001 > nul
echo ====================================================================
echo   KHỞI ĐỘNG HỆ THỐNG M49 BENCHMARK (BACKEND: 8000 - FRONTEND: 5173)
echo ====================================================================

start "Backend Server (Port 8000)" cmd /k "cd backend && python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload"
start "Frontend Server (Port 5173)" cmd /k "cd frontend && pnpm dev"

echo.
echo ✅ Đã khởi động xong cả 2 máy chủ!
echo 🌐 Vui lòng mở trình duyệt tại: http://localhost:5173
echo.
pause
