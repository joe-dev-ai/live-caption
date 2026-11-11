//! Keeps keyboard focus in Chrome while the overlay is clicked (Windows).
//!
//! The overlay window is created non-focusable (`WS_EX_NOACTIVATE`). WebView2
//! can still activate its host window on some systems when it is clicked, so
//! as a safety net we watch foreground changes and, if the overlay ever
//! becomes the foreground window, hand foreground straight back to the window
//! that had it before (once the mouse button is released, so dragging and
//! resizing keep working). Chrome then restores focus to the same text field.

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, IsWindow, SetForegroundWindow, EVENT_SYSTEM_FOREGROUND,
        WINEVENT_OUTOFCONTEXT,
    };

    static OVERLAY: AtomicIsize = AtomicIsize::new(0);
    static LAST_EXTERNAL: AtomicIsize = AtomicIsize::new(0);
    static RESTORE_PENDING: AtomicBool = AtomicBool::new(false);

    fn hwnd(v: isize) -> HWND {
        HWND(v as *mut core::ffi::c_void)
    }

    fn is_own(h: HWND) -> bool {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
        pid == unsafe { GetCurrentProcessId() }
    }

    unsafe extern "system" fn on_foreground(
        _hook: HWINEVENTHOOK,
        _event: u32,
        window: HWND,
        _id_object: i32,
        _id_child: i32,
        _thread: u32,
        _time: u32,
    ) {
        let h = window.0 as isize;
        if h == 0 {
            return;
        }
        if h == OVERLAY.load(Ordering::SeqCst) {
            restore_soon();
        } else if !is_own(window) {
            LAST_EXTERNAL.store(h, Ordering::SeqCst);
        }
    }

    fn restore_soon() {
        if RESTORE_PENDING.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(|| {
            let start = Instant::now();
            // Wait for the click / drag / resize to finish.
            while unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } < 0 && start.elapsed() < Duration::from_secs(15) {
                std::thread::sleep(Duration::from_millis(15));
            }
            let target = LAST_EXTERNAL.load(Ordering::SeqCst);
            let overlay = OVERLAY.load(Ordering::SeqCst);
            unsafe {
                if target != 0 && IsWindow(Some(hwnd(target))).as_bool() && GetForegroundWindow().0 as isize == overlay
                {
                    let _ = SetForegroundWindow(hwnd(target));
                }
            }
            RESTORE_PENDING.store(false, Ordering::SeqCst);
        });
    }

    /// Must be called on a thread that runs a message loop (Tauri's main thread).
    pub fn install(overlay_hwnd: isize) {
        OVERLAY.store(overlay_hwnd, Ordering::SeqCst);
        unsafe {
            let current = GetForegroundWindow();
            if !current.0.is_null() && !is_own(current) {
                LAST_EXTERNAL.store(current.0 as isize, Ordering::SeqCst);
            }
            let _hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(on_foreground),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
        }
    }
}

#[cfg(windows)]
pub use imp::install;
