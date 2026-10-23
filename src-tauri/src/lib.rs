mod backend;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
};
use tauri::{Emitter, Manager};

// 只有主窗口拥有应用退出权；辅助窗口关闭不能触发主窗口的关闭询问或后台退出。
fn route_window_event(
    label: &str,
    close_requested: bool,
    main_event: impl FnOnce(),
    leave_close: impl FnOnce(),
) {
    match label {
        "main" => main_event(),
        "leave-italent" if close_requested => leave_close(),
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            backend::backend_call,
            backend::backend_host_response,
            backend::eval_in_webview
        ])
        .setup(|app| {
            // 后台起不来不等于要静默退出：窗口照常显示，由界面提示「后台服务未启动」，
            // 关窗也不再被拦截。release 没有日志落点，直接结束进程时用户只看到「双击没反应」。
            match backend::Backend::start(app.handle().clone()) {
                Ok(node_backend) => {
                    app.manage(node_backend);
                }
                Err(error) => eprintln!("Node 后台启动失败，界面功能不可用：{error}"),
            }
            let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出程序", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let icon = app.default_window_icon().ok_or("缺少应用图标")?.clone();
            TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .tooltip("Personnel PLM（后台运行中）")
                .on_menu_event(|handle, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        if let Some(backend) = handle.try_state::<backend::Backend>() {
                            backend.stop();
                        }
                        std::process::exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick { .. } = event {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            route_window_event(
                window.label(),
                matches!(event, tauri::WindowEvent::CloseRequested { .. }),
                || {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if let Some(node_backend) =
                            window.app_handle().try_state::<backend::Backend>()
                        {
                            if !node_backend.is_quitting() {
                                // 关窗语义（每次询问/最小化到托盘/直接退出）由后台决定，必须能收到回执。
                                // 后台已退出或管道已断时不能再拦：否则点 × 毫无反应，用户只剩托盘菜单能退出。
                                if node_backend.is_alive() && node_backend.request_close().is_ok() {
                                    api.prevent_close();
                                } else {
                                    let _ = window.destroy();
                                }
                            }
                        }
                    }
                    if let tauri::WindowEvent::Destroyed = event {
                        if let Some(node_backend) =
                            window.app_handle().try_state::<backend::Backend>()
                        {
                            node_backend.stop();
                        }
                    }
                },
                || {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // 保留北森登录会话供下次连接使用。隐藏失败时放行原生关闭，不能把窗口锁住。
                        if window.hide().is_ok() {
                            api.prevent_close();
                        }
                        let _ = window.emit_to("main", "leave-italent-closed", ());
                    }
                },
            );
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod window_tests {
    use super::route_window_event;
    use std::cell::Cell;

    #[test]
    fn closing_and_destroying_auxiliary_windows_never_requests_application_exit() {
        let main_events = Cell::new(0);
        let leave_closes = Cell::new(0);
        for _ in 0..3 {
            route_window_event(
                "leave-italent",
                true,
                || main_events.set(main_events.get() + 1),
                || leave_closes.set(leave_closes.get() + 1),
            );
            // 包括隐藏失败后原生销毁，以及其他子窗口关闭/销毁。
            for label in ["leave-italent", "harness", "settings"] {
                route_window_event(
                    label,
                    false,
                    || main_events.set(main_events.get() + 1),
                    || panic!("销毁事件不应再次收起窗口"),
                );
            }
            route_window_event(
                "harness",
                true,
                || main_events.set(main_events.get() + 1),
                || panic!("其他子窗口不应进入北森流程"),
            );
        }
        assert_eq!(main_events.get(), 0, "辅助窗口不能关闭主程序或停止后台");
        assert_eq!(leave_closes.get(), 3, "北森窗口可以重复关闭并重新打开");
    }

    #[test]
    fn main_window_retains_close_and_destroy_lifecycle() {
        let main_events = Cell::new(0);
        for close_requested in [true, false] {
            route_window_event(
                "main",
                close_requested,
                || main_events.set(main_events.get() + 1),
                || panic!("主窗口不能进入北森收起流程"),
            );
        }
        assert_eq!(main_events.get(), 2);
    }
}
