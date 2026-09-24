use serde_json::{json, Value};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{Emitter, Manager};

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>;

/// WebView/Tauri 返回的 Windows 扩展路径（\\?\）不能直接作为 Node 24 的脚本参数。
fn node_compatible_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let raw = path.to_string_lossy();
        if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", unc));
        }
        if let Some(local) = raw.strip_prefix(r"\\?\") {
            return PathBuf::from(local);
        }
    }
    path
}

pub struct Backend {
    input: Mutex<ChildStdin>,
    pending: Pending,
    sequence: AtomicU64,
    child: Arc<Mutex<Child>>,
    quitting: AtomicBool,
    /// 后台是否仍在运行：读线程结束（管道关闭）或看门狗发现进程退出时置否。
    /// 关窗会把决定权交给后台（询问/最小化/退出三种偏好），后台不在时不能再拦关闭。
    alive: Arc<AtomicBool>,
}

impl Backend {
    pub fn start(app: tauri::AppHandle) -> Result<Self, String> {
        let project_root = node_compatible_path(PathBuf::from(env!("CARGO_MANIFEST_DIR")))
            .parent()
            .ok_or("无法定位项目目录")?
            .to_path_buf();
        let packaged_script = app
            .path()
            .resource_dir()
            .ok()
            .map(|dir| dir.join("backend/entry.cjs"));
        let packaged = packaged_script.as_ref().is_some_and(|path| path.is_file());
        let script = node_compatible_path(
            packaged_script
                .filter(|path| path.is_file())
                .unwrap_or_else(|| project_root.join("backend/entry.cjs")),
        );
        let resources = node_compatible_path(
            app.path()
                .resource_dir()
                .map_err(|error| error.to_string())?,
        );
        let bundled_node = resources.join(if cfg!(windows) { "node.exe" } else { "node" });
        let node = if packaged && bundled_node.is_file() {
            bundled_node
        } else {
            PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" })
        };
        let mut command = Command::new(node);
        command
            .arg(script)
            .current_dir(if packaged { &resources } else { &project_root })
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .env("PLM_PACKAGED", if packaged { "1" } else { "0" })
            .env("PLM_RESOURCES_DIR", &resources);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：GUI 应用启动 Node 后台不弹控制台。
        let mut child = command
            .spawn()
            .map_err(|error| format!("Node 后台启动失败：{error}"))?;
        let input = child.stdin.take().ok_or("Node 后台标准输入不可用")?;
        let output = child.stdout.take().ok_or("Node 后台标准输出不可用")?;
        let child = Arc::new(Mutex::new(child));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));

        let reader_pending = Arc::clone(&pending);
        let reader_app = app.clone();
        let reader_alive = Arc::clone(&alive);
        thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                match message.get("type").and_then(Value::as_str) {
                    Some("response") => {
                        if let Some(id) = message.get("id").and_then(Value::as_u64) {
                            if let Some(sender) = reader_pending.lock().unwrap().remove(&id) {
                                let result = match message.get("error").and_then(Value::as_str) {
                                    Some(error) => Err(error.to_owned()),
                                    None => {
                                        Ok(message.get("result").cloned().unwrap_or(Value::Null))
                                    }
                                };
                                let _ = sender.send(result);
                            }
                        }
                    }
                    Some("event") => {
                        let _ = reader_app.emit("backend-event", message);
                    }
                    Some("host") => handle_host(&reader_app, &message),
                    Some("host-call") => {
                        let _ = reader_app.emit("backend-host-call", message);
                    }
                    Some("ready") => {
                        let _ = reader_app.emit("backend-ready", message);
                    }
                    _ => {}
                }
            }
            for (_, sender) in reader_pending.lock().unwrap().drain() {
                let _ = sender.send(Err("Node 后台连接已断开".into()));
            }
            reader_alive.store(false, Ordering::Relaxed);
            let _ = reader_app.emit("backend-exit", ());
        });

        let watcher = Arc::clone(&child);
        let watcher_alive = Arc::clone(&alive);
        thread::spawn(move || loop {
            let exited = watcher
                .lock()
                .unwrap()
                .try_wait()
                .map(|status| status.is_some())
                .unwrap_or(true);
            if exited {
                watcher_alive.store(false, Ordering::Relaxed);
                break;
            }
            thread::sleep(Duration::from_millis(200));
        });

        Ok(Self {
            input: Mutex::new(input),
            pending,
            sequence: AtomicU64::new(0),
            child,
            quitting: AtomicBool::new(false),
            alive,
        })
    }

    fn send(&self, message: &Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut *input, message).map_err(|error| error.to_string())?;
        input.write_all(b"\n").map_err(|error| error.to_string())?;
        input.flush().map_err(|error| error.to_string())
    }

    pub fn stop(&self) {
        let _ = self.send(&json!({ "type": "shutdown" }));
        for _ in 0..20 {
            if self
                .child
                .lock()
                .unwrap()
                .try_wait()
                .ok()
                .flatten()
                .is_some()
            {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.lock().unwrap().kill();
    }

    /// 关窗请求交后台决定（询问/最小化/退出三种偏好）。返回 Err 表示管道已断，
    /// 调用方必须自行放行关闭，不能让窗口卡在「关不掉」。
    pub fn request_close(&self) -> Result<(), String> {
        self.send(&json!({ "type": "request", "id": 0, "channel": "win:close", "args": null }))
    }

    /// 后台进程是否仍在运行
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::Relaxed)
    }

    fn allow_quit(&self) {
        self.quitting.store(true, Ordering::Relaxed);
    }
}

fn handle_host(app: &tauri::AppHandle, message: &Value) {
    let action = message
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let payload = message.get("payload").cloned().unwrap_or(Value::Null);
    if action == "quit" {
        if let Some(backend) = app.try_state::<Backend>() {
            backend.allow_quit();
            backend.stop();
        }
        // Windows 中子 Webview 尚存时，事件循环退出可能留下空壳进程。
        std::process::exit(0);
    }
    if action == "close" {
        return;
    }
    const WINDOW_ACTIONS: [&str; 8] = [
        "minimize",
        "restore",
        "show",
        "maximize",
        "unmaximize",
        "fullscreen",
        "hide",
        "focus",
    ];
    if !WINDOW_ACTIONS.contains(&action) {
        let _ = app.emit("backend-host-event", message);
        return;
    }
    // Windows：创建过原生子 Webview（Harness 内嵌页）后，事件循环线程不再泵排队消息，
    // tauri 的窗口 API（内部经主线程投递）全部静默失效——标题栏三个按钮点了没反应。
    // Win32 直调不依赖主线程泵（ShowWindow 等由内核处理、sent 消息在等待点被处理），
    // 所以这里绕开 tauri API 直接操作系统窗口。
    #[cfg(windows)]
    let result = (|| -> Result<(), String> {
        use tauri::Manager;
        let hwnd = match app.get_webview_window("main") {
            Some(w) => w.hwnd().map_err(|e| e.to_string())?.0 as isize,
            // 子 Webview 存在时 get_webview_window 可能取不到，退回 window 管理器
            None => app
                .get_window("main")
                .ok_or_else(|| "主窗口不存在".to_string())?
                .hwnd()
                .map_err(|e| e.to_string())?
                .0 as isize,
        };
        host_window_op_win32_by_hwnd(hwnd, action, &payload)
    })();
    #[cfg(not(windows))]
    let result = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())
        .and_then(|window| host_window_op_tauri(&window, action, &payload));
    if let Err(error) = result {
        eprintln!("桌面窗口操作失败：{error}")
    }
}

#[allow(dead_code)]
fn host_window_op_tauri(
    window: &tauri::WebviewWindow,
    action: &str,
    payload: &Value,
) -> Result<(), tauri::Error> {
    match action {
        "minimize" => window.minimize(),
        "restore" | "show" => window.show(),
        "maximize" => window.maximize(),
        "unmaximize" => window.unmaximize(),
        "fullscreen" => window.set_fullscreen(payload.as_bool().unwrap_or(false)),
        "hide" => window.hide(),
        "focus" => window.set_focus(),
        _ => Ok(()),
    }
}

#[cfg(windows)]
fn host_window_op_win32_by_hwnd(
    raw_hwnd: isize,
    action: &str,
    payload: &Value,
) -> Result<(), String> {
    use std::sync::Mutex;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GetWindowPlacement, SetForegroundWindow, SetWindowLongPtrW,
        SetWindowPlacement, SetWindowPos, ShowWindow, GWL_STYLE, HWND_TOP, SWP_FRAMECHANGED,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOOWNERZORDER, SWP_NOZORDER, SWP_SHOWWINDOW,
        SW_HIDE, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, WINDOWPLACEMENT, WS_OVERLAPPEDWINDOW,
        WS_POPUP,
    };

    // 进入全屏前的样式与位置，退出时还原（tao 的做法）
    static FULLSCREEN_SAVED: Mutex<Option<(isize, WINDOWPLACEMENT)>> = Mutex::new(None);

    let hwnd = HWND(raw_hwnd as _);
    unsafe {
        match action {
            "minimize" => {
                let _ = ShowWindow(hwnd, SW_MINIMIZE);
            }
            "restore" | "show" => {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            "maximize" => {
                let _ = ShowWindow(hwnd, SW_MAXIMIZE);
            }
            "unmaximize" => {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            "hide" => {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
            "focus" => {
                let _ = SetForegroundWindow(hwnd);
            }
            "fullscreen" => {
                let want = payload.as_bool().unwrap_or(false);
                let mut saved = FULLSCREEN_SAVED.lock().map_err(|e| e.to_string())?;
                if want {
                    if saved.is_none() {
                        let mut placement = WINDOWPLACEMENT {
                            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
                            ..Default::default()
                        };
                        let _ = GetWindowPlacement(hwnd, &mut placement);
                        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
                        *saved = Some((style, placement));
                        let _ = SetWindowLongPtrW(
                            hwnd,
                            GWL_STYLE,
                            (style & !(WS_OVERLAPPEDWINDOW.0 as isize)) | WS_POPUP.0 as isize,
                        );
                        let mut mi = MONITORINFO {
                            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                            ..Default::default()
                        };
                        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                        if !GetMonitorInfoW(monitor, &mut mi).as_bool() {
                            return Err("读取显示器信息失败".into());
                        }
                        let r = mi.rcMonitor;
                        SetWindowPos(
                            hwnd,
                            Some(HWND_TOP),
                            r.left,
                            r.top,
                            r.right - r.left,
                            r.bottom - r.top,
                            SWP_FRAMECHANGED | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
                        )
                        .map_err(|e| e.to_string())?;
                    }
                } else if let Some((style, placement)) = saved.take() {
                    let _ = SetWindowLongPtrW(hwnd, GWL_STYLE, style);
                    let _ = SetWindowPlacement(hwnd, &placement);
                    // FRAMECHANGED 让样式变更立即生效；不动位置（placement 已还原）
                    SetWindowPos(
                        hwnd,
                        None,
                        0,
                        0,
                        0,
                        0,
                        SWP_FRAMECHANGED | SWP_NOOWNERZORDER | SWP_NOMOVE | SWP_NOSIZE
                            | SWP_NOZORDER | SWP_NOACTIVATE,
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            _ => return Ok(()),
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn backend_call(
    state: tauri::State<'_, Backend>,
    channel: String,
    args: Value,
) -> Result<Value, String> {
    let id = state.sequence.fetch_add(1, Ordering::Relaxed) + 1;
    let (sender, receiver) = mpsc::channel();
    state
        .pending
        .lock()
        .map_err(|error| error.to_string())?
        .insert(id, sender);
    if let Err(error) =
        state.send(&json!({ "type": "request", "id": id, "channel": channel, "args": args }))
    {
        state.pending.lock().unwrap().remove(&id);
        return Err(error);
    }
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv()
            .unwrap_or_else(|_| Err("Node 后台连接已断开".into()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn backend_host_response(
    state: tauri::State<'_, Backend>,
    id: u64,
    result: Value,
    error: Option<String>,
) -> Result<(), String> {
    state.send(&json!({ "type": "host-response", "id": id, "result": result, "error": error }))
}
