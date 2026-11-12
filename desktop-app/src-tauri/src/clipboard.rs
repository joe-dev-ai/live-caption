//! Copies caption text to the Windows clipboard the way ordinary programs
//! such as Notepad do: with one of our windows as the clipboard owner.
//!
//! The clipboard plugin opens the clipboard without a window, which leaves the
//! clipboard without an owner after it is written. Remote-desktop clients such
//! as Jump Desktop then don't forward the text to the remote computer: pasting
//! there did nothing until the same text was copied again from Notepad.

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
