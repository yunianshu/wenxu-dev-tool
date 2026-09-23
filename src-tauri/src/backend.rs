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
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let action = message
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let payload = message.get("payload").cloned().unwrap_or(Value::Null);
    let result = match action {
        "minimize" => window.minimize(),
        "restore" | "show" => window.show(),
        "maximize" => window.maximize(),
        "unmaximize" => window.unmaximize(),
        "fullscreen" => window.set_fullscreen(payload.as_bool().unwrap_or(false)),
        "hide" => window.hide(),
        "focus" => window.set_focus(),
        "close" => return,
        "quit" => {
            if let Some(backend) = app.try_state::<Backend>() {
                backend.allow_quit();
                backend.stop();
            }
            // Windows 中子 Webview 尚存时，事件循环退出可能留下空壳进程。
            std::process::exit(0);
        }
        _ => {
            let _ = app.emit("backend-host-event", message);
            return;
        }
    };
    if let Err(error) = result {
        eprintln!("桌面窗口操作失败：{error}")
    }
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
