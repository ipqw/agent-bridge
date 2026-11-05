// Agent Bridge shell: window + tray, starts and supervises the Node core.
// All bridge logic (gates, approvals, frpc, settings UI) lives in the core; the shell only
// keeps it alive, shows its UI, and raises the window when an approval is waiting.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, Url, WindowEvent};
use tauri_plugin_notification::NotificationExt;

const AUTOSTART_ARG: &str = "--autostart";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct Core {
    child: Option<Child>,
    stdin: Option<ChildStdin>, // held open: the core shuts down when it closes
    #[cfg(windows)]
    job: Option<job::Job>,
    quitting: bool,
}

type Shared = Arc<Mutex<Core>>;

fn main() {
    let autostart = std::env::args().any(|a| a == AUTOSTART_ARG);
    // "Выход" pauses the bridge until the next logon; the autostart task retries every minute.
    if autostart && pause::is_paused() {
        return;
    }
    if !autostart {
        pause::clear();
    }

    let shared: Shared = Arc::new(Mutex::new(Core::default()));
    let for_setup = shared.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|a| a == AUTOSTART_ARG) {
                show(app);
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            build_tray(&handle, for_setup.clone())?;
            if !autostart {
                show(&handle);
            }
            supervise(handle, for_setup.clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the app")
        .run(|_app, event| {
            // Hidden window != exit: the bridge keeps running in the tray until "Выход".
            if let RunEvent::ExitRequested { api, code, .. } = &event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &AppHandle, shared: Shared) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Открыть", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit_item])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Agent Bridge")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => show(app),
            "quit" => quit(app, &shared),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn quit(app: &AppHandle, shared: &Shared) {
    pause::set();
    {
        let mut core = shared.lock().unwrap();
        core.quitting = true;
        core.stdin = None; // lifeline closed -> core stops its children gracefully
    }
    std::thread::sleep(Duration::from_millis(1500));
    {
        let mut core = shared.lock().unwrap();
        if let Some(mut c) = core.child.take() {
            let _ = c.kill();
        }
        #[cfg(windows)]
        if let Some(j) = core.job.take() {
            j.terminate();
        }
    }
    app.exit(0);
}

fn log_file(app: &AppHandle) -> Option<File> {
    let dir = app.path().app_log_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    let path = dir.join("core.log");
    if fs::metadata(&path).map(|m| m.len() > 5_000_000).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("core.log.1"));
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

fn core_command(app: &AppHandle) -> std::io::Result<Command> {
    let res = plain_path(
        app.path()
            .resource_dir()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::NotFound, e.to_string()))?,
    )
    .join("resources");
    let node = std::env::var_os("SB_NODE")
        .map(PathBuf::from)
        .unwrap_or_else(|| res.join("node").join(if cfg!(windows) { "node.exe" } else { "node" }));
    let main_js = std::env::var_os("SB_CORE_MAIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| res.join("core").join("dist").join("main.js"));
    let mut cmd = Command::new(node);
    cmd.arg(main_js)
        .env("SB_RESOURCES", res.join("bin"))
        .env("SB_STDIN_LIFELINE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    if let Ok(exe) = std::env::current_exe() {
        cmd.env("SB_APP_EXE", plain_path(exe));
    }
    match log_file(app) {
        Some(f) => cmd.stderr(f),
        None => cmd.stderr(Stdio::null()),
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

// Tauri returns Windows paths in verbatim form (\\?\C:\...); Node cannot start a script from such a path.
fn plain_path(p: PathBuf) -> PathBuf {
    let stripped = {
        let s = p.to_string_lossy();
        s.strip_prefix(r"\\?\").filter(|r| !r.starts_with("UNC\\")).map(|r| r.to_string())
    };
    stripped.map(PathBuf::from).unwrap_or(p)
}

// Keep the core alive: restart with backoff; on each exit kill its whole process tree.
fn supervise(app: AppHandle, shared: Shared) {
    std::thread::spawn(move || {
        let mut backoff = Duration::from_secs(1);
        loop {
            if shared.lock().unwrap().quitting {
                break;
            }
            let started = Instant::now();
            match core_command(&app).and_then(|mut c| c.spawn()) {
                Ok(mut child) => {
                    #[cfg(windows)]
                    let job = job::Job::kill_on_close().and_then(|j| j.assign(&child).map(|_| j)).ok();
                    let stdout = child.stdout.take();
                    {
                        let mut core = shared.lock().unwrap();
                        core.stdin = child.stdin.take();
                        core.child = Some(child);
                        #[cfg(windows)]
                        {
                            core.job = job;
                        }
                    }
                    if let Some(out) = stdout {
                        for line in BufReader::new(out).lines() {
                            match line {
                                Ok(l) => on_core_line(&app, &l),
                                Err(_) => break,
                            }
                        }
                    }
                    let mut core = shared.lock().unwrap();
                    core.stdin = None;
                    if let Some(mut c) = core.child.take() {
                        let _ = c.kill();
                        let _ = c.wait();
                    }
                    #[cfg(windows)]
                    if let Some(j) = core.job.take() {
                        j.terminate();
                    }
                }
                Err(e) => eprintln!("core spawn failed: {e}"),
            }
            if shared.lock().unwrap().quitting {
                break;
            }
            if started.elapsed() > Duration::from_secs(60) {
                backoff = Duration::from_secs(1);
            }
            std::thread::sleep(backoff);
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    });
}

fn on_core_line(app: &AppHandle, line: &str) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("ready") => {
            if let (Some(url), Some(w)) = (v.get("url").and_then(|u| u.as_str()), app.get_webview_window("main")) {
                if let Ok(u) = Url::parse(url) {
                    let _ = w.navigate(u);
                }
            }
        }
        Some("approval") => {
            show(app);
            let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("");
            let _ = app
                .notification()
                .builder()
                .title("Agent Bridge: нужно подтверждение")
                .body(title.chars().take(180).collect::<String>())
                .show();
        }
        _ => {}
    }
}

// Pause marker: "Выход" keeps the bridge down until the next logon (identified by the logon SID).
mod pause {
    use std::fs;
    use std::path::PathBuf;

    fn marker() -> Option<PathBuf> {
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("agent-bridge").join("paused-logon"))
    }

    #[cfg(windows)]
    fn logon_id() -> Option<String> {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("whoami").arg("/logonid").creation_flags(super::CREATE_NO_WINDOW).output().ok()?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!s.is_empty()).then_some(s)
    }

    #[cfg(not(windows))]
    fn logon_id() -> Option<String> {
        None
    }

    pub fn is_paused() -> bool {
        match (marker(), logon_id()) {
            (Some(m), Some(id)) => fs::read_to_string(m).map(|s| s.trim() == id).unwrap_or(false),
            _ => false,
        }
    }

    pub fn set() {
        if let (Some(m), Some(id)) = (marker(), logon_id()) {
            if let Some(dir) = m.parent() {
                let _ = fs::create_dir_all(dir);
            }
            let _ = fs::write(m, id);
        }
    }

    pub fn clear() {
        if let Some(m) = marker() {
            let _ = fs::remove_file(m);
        }
    }
}

// Windows job object: the core and everything it spawns (frpc, MCP servers, shells) die together —
// when the core exits, and when this shell dies for any reason (KILL_ON_JOB_CLOSE).
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);
    unsafe impl Send for Job {}

    impl Job {
        pub fn kill_on_close() -> std::io::Result<Job> {
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    let e = std::io::Error::last_os_error();
                    CloseHandle(h);
                    return Err(e);
                }
                Ok(Job(h))
            }
        }

        pub fn assign(&self, child: &std::process::Child) -> std::io::Result<()> {
            let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
