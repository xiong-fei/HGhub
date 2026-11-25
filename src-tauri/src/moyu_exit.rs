//! Windows 全局退出键：鼠标右键 + 0，或右方向键 + 0。
//! 迷你窗不是焦点窗口时，页面内的 keydown 收不到，所以这里用低级钩子接管。

#[cfg(target_os = "windows")]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};

#[cfg(target_os = "windows")]
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
static APP: OnceLock<AppHandle> = OnceLock::new();
#[cfg(target_os = "windows")]
static RIGHT_DOWN: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static RIGHT_ARROW_DOWN: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "windows")]
pub fn install(app: AppHandle) {
    if APP.set(app).is_err() {
        return;
    }
    std::thread::spawn(|| unsafe {
        use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows_sys::Win32::UI::WindowsAndMessaging::*;

        let module = GetModuleHandleW(std::ptr::null());
        let keyboard_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), module, 0);
        let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module, 0);
        if keyboard_hook.is_null() || mouse_hook.is_null() {
            return;
        }

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn mouse_proc(code: i32, wparam: usize, lparam: isize) -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    if code >= 0 {
        match wparam as u32 {
            WM_LBUTTONUP => {
                // 原生窗口拖动/缩放会接管浏览器的 pointerup，用全局事件通知前端收尾。
                if let Some(app) = APP.get() {
                    let _ = app.emit("moyu-primary-up", ());
                }
            }
            WM_RBUTTONDOWN => RIGHT_DOWN.store(true, Ordering::SeqCst),
            WM_RBUTTONUP => RIGHT_DOWN.store(false, Ordering::SeqCst),
            _ => {}
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn keyboard_proc(code: i32, wparam: usize, lparam: isize) -> isize {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    if code >= 0 {
        let info = &*(lparam as *const KBDLLHOOKSTRUCT);
        let is_down = wparam as u32 == WM_KEYDOWN || wparam as u32 == WM_SYSKEYDOWN;
        let is_up = wparam as u32 == WM_KEYUP || wparam as u32 == WM_SYSKEYUP;
        if info.vkCode == VK_RIGHT as u32 {
            RIGHT_ARROW_DOWN.store(is_down, Ordering::SeqCst);
        }
        if is_down
            && (info.vkCode == 0x30 || info.vkCode == VK_NUMPAD0 as u32)
            && (RIGHT_DOWN.load(Ordering::SeqCst) || RIGHT_ARROW_DOWN.load(Ordering::SeqCst))
        {
            if let Some(app) = APP.get() {
                app.exit(0);
            }
            return 1;
        }
        if is_up && info.vkCode == VK_RIGHT as u32 {
            RIGHT_ARROW_DOWN.store(false, Ordering::SeqCst);
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}
