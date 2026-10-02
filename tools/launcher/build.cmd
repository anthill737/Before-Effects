@echo off
rem Builds the double-click launcher "Before Effects.exe" into the project root (MSVC, static runtime).
setlocal
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (echo Visual Studio C++ build tools not found & exit /b 1)
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d "%~dp0"
rc /nologo /fo launcher.res launcher.rc || exit /b 1
cl /nologo /O2 /MT /EHsc /W4 /permissive- /std:c++20 /DUNICODE /D_UNICODE launcher.cpp launcher.res /Fo:launcher.obj /Fe:"..\..\Before Effects.exe" /link /SUBSYSTEM:WINDOWS || exit /b 1
del launcher.obj launcher.res >nul 2>&1
echo Built "%~dp0..\..\Before Effects.exe"
