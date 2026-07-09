@echo off
rem 全局 CLI 转发器：cxx <子命令> → 同装目录下的 daemon 二进制。
rem %~dp0 展开为本 .cmd 所在目录（即安装根 {app}\），末尾自带反斜杠。
"%~dp0resources\cxx-daemon.exe" %*
