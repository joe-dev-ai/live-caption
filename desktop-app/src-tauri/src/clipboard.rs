//! Copies caption text to the Windows clipboard so that it can also be pasted
//! on the remote computer in Jump Desktop.
//!
//! * The text is written the way ordinary programs such as Notepad do it,
//!   with one of our windows as the clipboard owner (the clipboard plugin
//!   leaves the clipboard without an owner).
//! * Jump Desktop sends the local clipboard to the remote computer when its
//!   window is activated, not when the clipboard changes. The overlay never
//!   takes focus, so after copying from it Jump Desktop kept sending the old
//!   text; clicking the taskbar and back into Jump Desktop made it work.
//!   [`hand_to_jump_desktop`] does that switch automatically.

/// How long Jump Desktop's window stays in the background during the hand-off,
/// so it handles losing the foreground before it gets it back.
#[cfg(windows)]
const HAND_OFF_PAUSE: std::time::Duration = std::time::Duration::from_millis(60);

/// Text as Windows expects it on the clipboard: CRLF line breaks, UTF-16,
/// NUL-terminated.
#[cfg(any(windows, test))]
fn clipboard_utf16(text: &str) -> Vec<u16> {
    text.replace("\r\n", "\n")
        .replace('\n', "\r\n")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

/// Put `text` on the clipboard as Unicode text owned by the window `owner`.
#[cfg(windows)]
pub fn write_text(owner: windows::Win32::Foundation::HWND, text: &str) -> Result<(), String> {
    use windows::Win32::Foundation::{GlobalFree, HANDLE};
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    /// Standard clipboard format for UTF-16 text; Windows derives the ANSI
    /// and OEM text formats from it for programs that ask for those.
    const CF_UNICODETEXT: u32 = 13;

    let data = clipboard_utf16(text);
    unsafe {
        let mem = GlobalAlloc(GMEM_MOVEABLE, data.len() * 2).map_err(|e| e.to_string())?;
        let dest = GlobalLock(mem).cast::<u16>();
        if dest.is_null() {
            let _ = GlobalFree(Some(mem));
            return Err("out of memory".into());
        }
        std::ptr::copy_nonoverlapping(data.as_ptr(), dest, data.len());
        // Reports an "error" once the lock count drops to zero, which is the expected outcome here.
        let _ = GlobalUnlock(mem);

        if let Err(e) = open(owner) {
            let _ = GlobalFree(Some(mem));
            return Err(format!("the clipboard is in use by another program ({e})"));
        }
        // EmptyClipboard makes `owner` the clipboard owner.
        let result = EmptyClipboard().and_then(|()| SetClipboardData(CF_UNICODETEXT, Some(HANDLE(mem.0))));
        let _ = CloseClipboard();
        match result {
            // The clipboard owns the memory from now on.
            Ok(_) => Ok(()),
            Err(e) => {
                let _ = GlobalFree(Some(mem));
                Err(e.to_string())
            }
        }
    }
}

/// If a Jump Desktop window (one of `jump_names`) is in front, briefly
/// activate a tiny off-screen window of ours and give the foreground straight
/// back, so Jump Desktop reads the new clipboard and sends it to the remote
/// computer. Returns whether the hand-off started. Other programs, Chrome
/// included, are never touched. Must run on the main thread.
#[cfg(windows)]
pub fn hand_to_jump_desktop(app: &tauri::AppHandle, jump_names: &[String]) -> bool {
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetForegroundWindow, SetForegroundWindow, WS_EX_TOOLWINDOW, WS_POPUP,
        WS_VISIBLE,
    };

    let jump = unsafe { GetForegroundWindow() };
    let is_jump = crate::process::window_exe(jump).is_some_and(|exe| crate::process::is_jump_exe(&exe, jump_names));
    if !is_jump {
        return false;
    }
    // A 1×1 tool window far off screen: no taskbar button, nothing visible.
    let Ok(helper) = (unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW,
            w!("STATIC"),
            w!(""),
            WS_POPUP | WS_VISIBLE,
            -32000,
            -32000,
            1,
            1,
            None,
            None,
            None,
            None,
        )
    }) else {
        return false;
    };
    // Allowed because the user just clicked the overlay or pressed our hotkey.
    if !unsafe { SetForegroundWindow(helper) }.as_bool() {
        let _ = unsafe { DestroyWindow(helper) };
        return false;
    }
    // Window handles aren't Send; pass them as plain numbers.
    let (jump, helper) = (jump.0 as isize, helper.0 as isize);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(HAND_OFF_PAUSE);
        // The helper belongs to the main thread, so it must be destroyed there.
        let _ = app.run_on_main_thread(move || unsafe {
            let _ = SetForegroundWindow(HWND(jump as _));
            let _ = DestroyWindow(HWND(helper as _));
        });
    });
    true
}

/// Open the clipboard for `owner`. Other programs, often the remote-desktop
/// client reading what was just copied, can hold it for a moment, so retry
/// briefly like browsers do.
#[cfg(windows)]
fn open(owner: windows::Win32::Foundation::HWND) -> windows::core::Result<()> {
    use windows::Win32::System::DataExchange::OpenClipboard;
    let mut attempts = 0;
    loop {
        match unsafe { OpenClipboard(Some(owner)) } {
            Err(_) if attempts < 10 => {
                attempts += 1;
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            result => return result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::clipboard_utf16;

    fn decode(units: &[u16]) -> String {
        String::from_utf16(units).unwrap()
    }

    #[test]
    fn text_gets_windows_line_breaks_and_a_terminating_nul() {
        let units = clipboard_utf16("Hello world.\nHow are you?");
        assert_eq!(units.last(), Some(&0));
        assert_eq!(decode(&units[..units.len() - 1]), "Hello world.\r\nHow are you?");
    }

    #[test]
    fn existing_crlf_is_kept_and_non_ascii_survives() {
        let units = clipboard_utf16("Grüße\r\n日本語 😀");
        assert_eq!(decode(&units[..units.len() - 1]), "Grüße\r\n日本語 😀");
    }
}
