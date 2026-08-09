@echo off
rem 啟動日文斷詞助手：在本機開一個小型網頁伺服器，並打開瀏覽器
cd /d "%~dp0"
start "" http://localhost:8321/
python -m http.server 8321
