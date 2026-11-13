//! Locating the Jump Desktop process (Windows) for per-app audio capture.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
}

/// Find the root-most process whose executable name matches one of `names`
/// (lower-case, e.g. "jumpdesktop.exe"). Earlier names in the list win.
#[cfg(windows)]
pub fn find_jump_desktop(names: &[String]) -> Option<ProcInfo> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    let mut matches: Vec<(u32, u32, String, usize)> = Vec::new(); // pid, ppid, name, rank
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut ok = Process32FirstW(snapshot, &mut entry).is_ok();
        while ok {
            let len = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
            let lower = exe.to_lowercase();
            if let Some(rank) = names.iter().position(|n| *n == lower) {
                matches.push((entry.th32ProcessID, entry.th32ParentProcessID, exe, rank));
            }
            ok = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    let pids: Vec<u32> = matches.iter().map(|m| m.0).collect();
    // Prefer processes whose parent is not itself a Jump Desktop process:
    // capturing the root with "include process tree" covers its children.
    matches
        .iter()
        .filter(|m| !pids.contains(&m.1))
        .min_by_key(|m| (m.3, m.0))
        .or_else(|| matches.iter().min_by_key(|m| (m.3, m.0)))
        .map(|m| ProcInfo {
            pid: m.0,
            name: m.2.clone(),
        })
}

#[cfg(windows)]
pub fn is_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut code = 0u32;
        let alive = GetExitCodeProcess(handle, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
        let _ = CloseHandle(handle);
        alive
    }
}

#[cfg(not(windows))]
pub fn find_jump_desktop(_names: &[String]) -> Option<ProcInfo> {
    None
}

/// Whether the executable at `path` is one of `names` (lower-case file names,
/// e.g. "jumpdesktop.exe").
#[cfg(any(windows, test))]
pub fn is_jump_exe(path: &str, names: &[String]) -> bool {
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path).to_lowercase();
    names.contains(&file)
}

/// Full path of the executable that owns `window`.
#[cfg(windows)]
pub fn window_exe(window: windows::Win32::Foundation::HWND) -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(window, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(handle);
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

#[cfg(test)]
mod tests {
    use super::is_jump_exe;

    #[test]
    fn jump_exe_is_matched_by_file_name_in_any_case() {
        let names = vec!["jumpdesktop.exe".to_string(), "jumpclient.exe".to_string()];
        assert!(is_jump_exe(r"C:\Program Files\Jump Desktop\JumpDesktop.exe", &names));
        assert!(is_jump_exe("JUMPCLIENT.EXE", &names));
        assert!(!is_jump_exe(
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            &names
        ));
        assert!(!is_jump_exe(r"C:\Tools\notjumpdesktop.exe", &names));
    }
}
