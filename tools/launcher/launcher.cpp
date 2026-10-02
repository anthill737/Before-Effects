// Before Effects launcher — the file people double-click ("Before Effects.exe" in the project folder).
//
// What it does, in order:
//   1. Finds the project folder from its own location (works from any working directory).
//   2. Makes sure the packaged app exists and is current; rebuilds it automatically when the
//      sources are newer and Node.js + pnpm are available, with a progress window.
//   3. Checks prerequisites (FFmpeg) and explains any fix in plain language.
//   4. Starts the app inside a Windows job object, so every background process it starts
//      (FFmpeg, render workers, assistant tools) ends when the app ends — even after a crash.
//   5. Stays invisible while the app runs. A second launch hands over to the running copy.
//      If the app exits with an error, shows what happened and offers to restart or open the log.
//
// Build: tools\launcher\build.cmd  (MSVC, static runtime; no runtime dependencies).

#ifndef UNICODE
#define UNICODE
#endif
#include <windows.h>
#include <commctrl.h>
#include <knownfolders.h>
#include <objbase.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>

#include <cstdio>
#include <ctime>
#include <string>
#include <vector>

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "advapi32.lib")

using std::wstring;

static wstring g_root, g_appExe, g_logDir, g_launcherLog, g_buildLog;

// ---------------------------------------------------------------------------------------------
// Small helpers

static wstring DirName(const wstring& p) {
  size_t i = p.find_last_of(L"\\/");
  return i == wstring::npos ? p : p.substr(0, i);
}

static bool Exists(const wstring& p) { return GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES; }

static wstring KnownFolder(REFKNOWNFOLDERID id) {
  PWSTR raw = nullptr;
  wstring out;
  if (SUCCEEDED(SHGetKnownFolderPath(id, 0, nullptr, &raw))) out = raw;
  CoTaskMemFree(raw);
  return out;
}

static void Log(const wstring& msg) {
  if (g_launcherLog.empty()) return;
  FILE* f = nullptr;
  if (_wfopen_s(&f, g_launcherLog.c_str(), L"a, ccs=UTF-8") == 0 && f) {
    SYSTEMTIME st;
    GetLocalTime(&st);
    fwprintf(f, L"%04d-%02d-%02d %02d:%02d:%02d %s\n", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, msg.c_str());
    fclose(f);
  }
}

static ULONGLONG FileTime(const wstring& path) {
  WIN32_FILE_ATTRIBUTE_DATA d;
  if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &d)) return 0;
  return (static_cast<ULONGLONG>(d.ftLastWriteTime.dwHighDateTime) << 32) | d.ftLastWriteTime.dwLowDateTime;
}

/** Newest modification time of any file under `dir` (skipping node_modules and build output). */
static ULONGLONG NewestUnder(const wstring& dir) {
  ULONGLONG best = 0;
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW((dir + L"\\*").c_str(), &fd);
  if (h == INVALID_HANDLE_VALUE) return 0;
  do {
    wstring name = fd.cFileName;
    if (name == L"." || name == L".." || name == L"node_modules" || name == L"out" || name == L".vite") continue;
    wstring full = dir + L"\\" + name;
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
      ULONGLONG t = NewestUnder(full);
      if (t > best) best = t;
    } else {
      ULONGLONG t = (static_cast<ULONGLONG>(fd.ftLastWriteTime.dwHighDateTime) << 32) | fd.ftLastWriteTime.dwLowDateTime;
      if (t > best) best = t;
    }
  } while (FindNextFileW(h, &fd));
  FindClose(h);
  return best;
}

static ULONGLONG NewestSource() {
  ULONGLONG best = 0;
  const wchar_t* dirs[] = {L"\\apps\\studio\\src", L"\\apps\\studio\\scripts", L"\\packages"};
  for (auto d : dirs) {
    ULONGLONG t = NewestUnder(g_root + d);
    if (t > best) best = t;
  }
  const wchar_t* files[] = {L"\\pnpm-lock.yaml", L"\\apps\\studio\\package.json", L"\\apps\\studio\\electron.vite.config.ts"};
  for (auto f : files) {
    ULONGLONG t = FileTime(g_root + f);
    if (t > best) best = t;
  }
  return best;
}

static wstring FindOnPath(const wchar_t* exe) {
  wchar_t buf[MAX_PATH];
  if (SearchPathW(nullptr, exe, nullptr, MAX_PATH, buf, nullptr)) return buf;
  return L"";
}

static wstring FindPnpm() {
  wstring p = FindOnPath(L"pnpm.cmd");
  if (!p.empty()) return p;
  wstring roaming = KnownFolder(FOLDERID_RoamingAppData);
  if (Exists(roaming + L"\\npm\\pnpm.cmd")) return roaming + L"\\npm\\pnpm.cmd";
  return L"";
}

static wstring FindNode() {
  wstring p = FindOnPath(L"node.exe");
  if (!p.empty()) return p;
  wstring pf = KnownFolder(FOLDERID_ProgramFiles);
  if (Exists(pf + L"\\nodejs\\node.exe")) return pf + L"\\nodejs\\node.exe";
  return L"";
}

static bool FfmpegAvailable() {
  if (Exists(DirName(g_appExe) + L"\\resources\\bin\\ffmpeg.exe")) return true;
  if (!FindOnPath(L"ffmpeg.exe").empty()) return true;
  wstring local = KnownFolder(FOLDERID_LocalAppData);
  return Exists(local + L"\\Microsoft\\WinGet\\Links\\ffmpeg.exe");
}

/** A running .exe cannot be opened for writing, which tells us the app is already open. */
static bool AppRunning() {
  HANDLE h = CreateFileW(g_appExe.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
  if (h == INVALID_HANDLE_VALUE) {
    DWORD e = GetLastError();
    return e == ERROR_SHARING_VIOLATION || e == ERROR_ACCESS_DENIED;
  }
  CloseHandle(h);
  return false;
}

static wstring Tail(const wstring& path, size_t maxChars = 2500) {
  FILE* f = nullptr;
  if (_wfopen_s(&f, path.c_str(), L"rb") != 0 || !f) return L"(no log yet)";
  fseek(f, 0, SEEK_END);
  long size = ftell(f);
  long start = size > static_cast<long>(maxChars) ? size - static_cast<long>(maxChars) : 0;
  fseek(f, start, SEEK_SET);
  std::string bytes(static_cast<size_t>(size - start), '\0');
  size_t n = fread(bytes.data(), 1, bytes.size(), f);
  fclose(f);
  bytes.resize(n);
  int wlen = MultiByteToWideChar(CP_UTF8, 0, bytes.data(), static_cast<int>(bytes.size()), nullptr, 0);
  wstring w(static_cast<size_t>(wlen), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, bytes.data(), static_cast<int>(bytes.size()), w.data(), wlen);
  return w;
}

// ---------------------------------------------------------------------------------------------
// Dialogs

enum { BTN_RETRY = 1001, BTN_LOG = 1002, BTN_CLOSE = 1003, BTN_INSTALL = 1004, BTN_CONTINUE = 1005, BTN_NODE = 1006, BTN_PREVIOUS = 1007 };

static int Ask(const wstring& title, const wstring& main, const wstring& body, std::vector<TASKDIALOG_BUTTON> buttons, const wstring& details = L"", PCWSTR icon = TD_ERROR_ICON) {
  TASKDIALOGCONFIG c = {sizeof(c)};
  c.hInstance = GetModuleHandleW(nullptr);
  c.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW | TDF_SIZE_TO_CONTENT;
  c.pszWindowTitle = title.c_str();
  c.pszMainIcon = icon;
  c.pszMainInstruction = main.c_str();
  c.pszContent = body.c_str();
  c.cButtons = static_cast<UINT>(buttons.size());
  c.pButtons = buttons.data();
  if (!details.empty()) {
    c.pszExpandedInformation = details.c_str();
    c.pszCollapsedControlText = L"Show details";
    c.pszExpandedControlText = L"Hide details";
  }
  int pressed = BTN_CLOSE;
  if (FAILED(TaskDialogIndirect(&c, &pressed, nullptr, nullptr))) {
    MessageBoxW(nullptr, (main + L"\n\n" + body).c_str(), title.c_str(), MB_OK | MB_ICONERROR);
    return BTN_CLOSE;
  }
  return pressed == IDCANCEL ? BTN_CLOSE : pressed;
}

/** Run a hidden command with a progress window; returns the exit code. */
struct Job {
  wstring cmdline;
  DWORD exitCode = 1;
  HWND dialog = nullptr;
  bool done = false;
};

static DWORD WINAPI RunJobThread(LPVOID p) {
  Job* job = static_cast<Job*>(p);
  STARTUPINFOW si = {sizeof(si)};
  PROCESS_INFORMATION pi = {};
  std::vector<wchar_t> cmd(job->cmdline.begin(), job->cmdline.end());
  cmd.push_back(0);
  if (CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, g_root.c_str(), &si, &pi)) {
    WaitForSingleObject(pi.hProcess, INFINITE);
    GetExitCodeProcess(pi.hProcess, &job->exitCode);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  } else {
    job->exitCode = GetLastError();
  }
  job->done = true;
  if (job->dialog) PostMessageW(job->dialog, TDM_CLICK_BUTTON, IDOK, 0);
  return 0;
}

static HRESULT CALLBACK ProgressCallback(HWND hwnd, UINT msg, WPARAM, LPARAM, LONG_PTR ref) {
  Job* job = reinterpret_cast<Job*>(ref);
  if (msg == TDN_CREATED) {
    job->dialog = hwnd;
    SendMessageW(hwnd, TDM_SET_PROGRESS_BAR_MARQUEE, TRUE, 30);
    SendMessageW(hwnd, TDM_ENABLE_BUTTON, IDOK, FALSE);
    if (job->done) PostMessageW(hwnd, TDM_CLICK_BUTTON, IDOK, 0);
  }
  return S_OK;
}

static DWORD RunWithProgress(const wstring& title, const wstring& main, const wstring& body, const wstring& cmdline) {
  Job job;
  job.cmdline = cmdline;
  HANDLE t = CreateThread(nullptr, 0, RunJobThread, &job, 0, nullptr);
  TASKDIALOGCONFIG c = {sizeof(c)};
  c.hInstance = GetModuleHandleW(nullptr);
  c.dwFlags = TDF_SHOW_MARQUEE_PROGRESS_BAR | TDF_CALLBACK_TIMER;
  c.pszWindowTitle = title.c_str();
  c.pszMainIcon = TD_INFORMATION_ICON;
  c.pszMainInstruction = main.c_str();
  c.pszContent = body.c_str();
  c.dwCommonButtons = TDCBF_OK_BUTTON;
  c.pfCallback = ProgressCallback;
  c.lpCallbackData = reinterpret_cast<LONG_PTR>(&job);
  // The dialog closes itself when the work finishes; closing it early just hides it.
  TaskDialogIndirect(&c, nullptr, nullptr, nullptr);
  WaitForSingleObject(t, INFINITE);
  CloseHandle(t);
  return job.exitCode;
}

// ---------------------------------------------------------------------------------------------

static void CreateDesktopShortcut(bool force) {
  wstring marker = g_logDir + L"\\..\\desktop-shortcut-created";
  if (!force && Exists(marker)) return;  // created once; respect it if the person deleted it
  wstring desktop = KnownFolder(FOLDERID_Desktop);
  if (desktop.empty()) return;
  wchar_t self[MAX_PATH];
  GetModuleFileNameW(nullptr, self, MAX_PATH);
  IShellLinkW* link = nullptr;
  if (SUCCEEDED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link)))) {
    link->SetPath(self);
    link->SetWorkingDirectory(g_root.c_str());
    link->SetIconLocation(self, 0);
    link->SetDescription(L"Before Effects — projection mapping studio");
    IPersistFile* file = nullptr;
    if (SUCCEEDED(link->QueryInterface(IID_PPV_ARGS(&file)))) {
      if (SUCCEEDED(file->Save((desktop + L"\\Before Effects.lnk").c_str(), TRUE))) Log(L"desktop shortcut created");
      file->Release();
    }
    link->Release();
  }
  HANDLE h = CreateFileW(marker.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, 0, nullptr);
  if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
}

static bool EnsureBuilt(bool sourcesChanged) {
  wstring node = FindNode();
  wstring pnpm = FindPnpm();
  bool haveApp = Exists(g_appExe);
  if (!sourcesChanged && haveApp) return true;
  if (AppRunning()) return true;  // never rebuild under a running app; hand over to it instead
  if (node.empty() || pnpm.empty()) {
    if (haveApp) {
      Log(L"sources changed but Node.js/pnpm are not available; launching the existing build");
      return true;
    }
    int r = Ask(L"Before Effects", L"Before Effects needs to be prepared once",
                L"This copy of Before Effects hasn't been built yet, and the tools that build it (Node.js and pnpm) aren't installed.\n\n"
                L"1. Install Node.js (LTS) from nodejs.org.\n2. Then double-click Before Effects again — it prepares itself automatically.",
                {{BTN_NODE, L"Open nodejs.org"}, {BTN_CLOSE, L"Close"}}, L"", TD_WARNING_ICON);
    if (r == BTN_NODE) ShellExecuteW(nullptr, L"open", L"https://nodejs.org/en/download", nullptr, nullptr, SW_SHOWNORMAL);
    return false;
  }
  for (;;) {
    DeleteFileW(g_buildLog.c_str());
    Log(L"building the app (sources changed or build missing)");
    wstring cmd = L"cmd.exe /d /s /c \"\"" + pnpm + L"\" install --frozen-lockfile --prefer-offline >> \"" + g_buildLog + L"\" 2>&1 && \"" + pnpm +
                  L"\" --filter @be/studio package >> \"" + g_buildLog + L"\" 2>&1\"";
    DWORD code = RunWithProgress(L"Before Effects", haveApp ? L"Updating Before Effects…" : L"Getting Before Effects ready…",
                                 L"This happens once after an update and usually takes under a minute.", cmd);
    if (code == 0 && Exists(g_appExe)) {
      Log(L"build finished");
      return true;
    }
    Log(L"build failed with code " + std::to_wstring(code));
    std::vector<TASKDIALOG_BUTTON> buttons = {{BTN_RETRY, L"Try again"}, {BTN_LOG, L"Open the build log"}};
    if (haveApp) buttons.push_back({BTN_PREVIOUS, L"Start the previous version"});
    buttons.push_back({BTN_CLOSE, L"Close"});
    int r = Ask(L"Before Effects", L"Before Effects couldn't be prepared",
                L"The update step stopped with an error. Close any open Before Effects windows and try again. If it keeps happening, the log below explains why.",
                buttons, Tail(g_buildLog));
    if (r == BTN_RETRY) continue;
    if (r == BTN_LOG) ShellExecuteW(nullptr, L"open", g_buildLog.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    if (r == BTN_PREVIOUS) return true;
    return false;
  }
}

static bool CheckFfmpeg() {
  if (FfmpegAvailable()) return true;
  int r = Ask(L"Before Effects", L"FFmpeg is missing",
              L"Before Effects uses FFmpeg to read and save videos. You can still open and edit shows without it, but exporting won't work.\n\n"
              L"Install it now? (Uses Windows Package Manager; takes about a minute.)",
              {{BTN_INSTALL, L"Install FFmpeg"}, {BTN_CONTINUE, L"Continue without it"}, {BTN_CLOSE, L"Close"}}, L"", TD_WARNING_ICON);
  if (r == BTN_CLOSE) return false;
  if (r == BTN_INSTALL) {
    DWORD code = RunWithProgress(L"Before Effects", L"Installing FFmpeg…", L"Downloading from the Windows Package Manager.",
                                 L"winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements --silent");
    if (code != 0)
      Ask(L"Before Effects", L"FFmpeg couldn't be installed automatically",
          L"Open a terminal and run:  winget install Gyan.FFmpeg\nBefore Effects will start now; exporting stays unavailable until FFmpeg is installed.", {{BTN_CLOSE, L"OK"}},
          L"", TD_WARNING_ICON);
  }
  return true;
}

static int RunApp(const wstring& extraArgs) {
  for (;;) {
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION lim = {};
    lim.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(job, JobObjectExtendedLimitInformation, &lim, sizeof(lim));

    wstring cmd = L"\"" + g_appExe + L"\"" + (extraArgs.empty() ? L"" : L" " + extraArgs);
    std::vector<wchar_t> buf(cmd.begin(), cmd.end());
    buf.push_back(0);
    STARTUPINFOW si = {sizeof(si)};
    PROCESS_INFORMATION pi = {};
    Log(L"starting " + cmd);
    if (!CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED, nullptr, DirName(g_appExe).c_str(), &si, &pi)) {
      DWORD e = GetLastError();
      CloseHandle(job);
      int r = Ask(L"Before Effects", L"Before Effects couldn't start",
                  L"Windows refused to start the app (error " + std::to_wstring(e) + L"). An antivirus program may be blocking it, or the build is damaged.",
                  {{BTN_RETRY, L"Try again"}, {BTN_CLOSE, L"Close"}});
      if (r == BTN_RETRY) continue;
      return 1;
    }
    AssignProcessToJobObject(job, pi.hProcess);
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    ULONGLONG started = GetTickCount64();
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    // Closing the job ends anything the app left behind (FFmpeg, helpers).
    CloseHandle(job);
    Log(L"app exited with code " + std::to_wstring(code) + L" after " + std::to_wstring((GetTickCount64() - started) / 1000) + L" s");
    if (code == 0) return 0;
    wstring mainLog = g_logDir + L"\\main.log";
    bool early = GetTickCount64() - started < 15000;
    int r = Ask(L"Before Effects", early ? L"Before Effects stopped while starting" : L"Before Effects closed unexpectedly",
                L"Your work is backed up automatically every few seconds; when you start again you'll be offered to recover it.\n\n"
                L"Exit code: " + std::to_wstring(code),
                {{BTN_RETRY, L"Start again"}, {BTN_LOG, L"Open the log folder"}, {BTN_CLOSE, L"Close"}}, Tail(mainLog));
    if (r == BTN_LOG) ShellExecuteW(nullptr, L"open", g_logDir.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    if (r != BTN_RETRY) return static_cast<int>(code);
  }
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR cmdLine, int) {
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  INITCOMMONCONTROLSEX icc = {sizeof(icc), ICC_STANDARD_CLASSES | ICC_PROGRESS_CLASS};
  InitCommonControlsEx(&icc);

  wchar_t self[MAX_PATH];
  GetModuleFileNameW(nullptr, self, MAX_PATH);
  g_root = DirName(self);
  g_appExe = g_root + L"\\build\\app\\Before Effects.exe";
  g_logDir = KnownFolder(FOLDERID_RoamingAppData) + L"\\Before Effects\\logs";
  SHCreateDirectoryExW(nullptr, g_logDir.c_str(), nullptr);
  g_launcherLog = g_logDir + L"\\launcher.log";
  g_buildLog = g_logDir + L"\\build.log";
  Log(L"launcher started from " + g_root);

  wstring args = cmdLine ? cmdLine : L"";
  if (args.find(L"--create-desktop-shortcut") != wstring::npos) {
    CreateDesktopShortcut(true);
    return 0;
  }
  bool forceBuild = args.find(L"--rebuild") != wstring::npos;

  if (!Exists(g_root + L"\\apps\\studio") && !Exists(g_appExe)) {
    Ask(L"Before Effects", L"This launcher is in the wrong folder",
        L"Keep \"Before Effects.exe\" in the Before Effects project folder (next to the apps and packages folders), or use the desktop shortcut.", {{BTN_CLOSE, L"Close"}});
    return 1;
  }

  ULONGLONG built = FileTime(DirName(g_appExe) + L"\\resources\\build-info.json");
  bool changed = forceBuild || !Exists(g_appExe) || (Exists(g_root + L"\\apps\\studio") && NewestSource() > built);
  if (!EnsureBuilt(changed)) return 1;
  if (!CheckFfmpeg()) return 1;
  CreateDesktopShortcut(false);

  // Pass through app arguments (e.g. --ui-test); the launcher's own flags are removed.
  wstring pass;
  if (args.find(L"--ui-test") != wstring::npos) pass = L"--ui-test";
  int code = RunApp(pass);
  CoUninitialize();
  return code;
}
