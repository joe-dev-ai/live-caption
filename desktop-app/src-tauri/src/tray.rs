//! System tray icon and menu: Show/Hide, Start/Stop, Settings, Quit.
//! The icon switches to a red "live" variant while captioning.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Wry};

const ICON_IDLE: &[u8] = include_bytes!("../icons/tray-idle.png");
const ICON_ACTIVE: &[u8] = include_bytes!("../icons/tray-active.png");

pub struct Tray {
    icon: TrayIcon,
    toggle_item: MenuItem<Wry>,
}

impl Tray {
    pub fn create(app: &AppHandle) -> tauri::Result<Self> {
        let show = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
        let toggle_item = MenuItem::with_id(app, "toggle", "Start captioning", true, None::<&str>)?;
        let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        let sep = PredefinedMenuItem::separator(app)?;
        let menu = Menu::with_items(app, &[&show, &toggle_item, &settings, &sep, &quit])?;

        let icon = TrayIconBuilder::with_id("main-tray")
            .icon(Image::from_bytes(ICON_IDLE)?)
            .tooltip("Live Caption Overlay — idle")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id().as_ref() {
                "show" => crate::toggle_overlay(app),
                "toggle" => {
                    let _ = app.emit_to("main", "toggle-captioning", ());
                }
                "settings" => crate::open_settings_window(app),
                "quit" => crate::quit(app),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    crate::toggle_overlay(tray.app_handle());
                }
            })
            .build(app)?;
        Ok(Self { icon, toggle_item })
    }

    pub fn set_active(&self, active: bool) {
        let bytes = if active { ICON_ACTIVE } else { ICON_IDLE };
        if let Ok(img) = Image::from_bytes(bytes) {
            let _ = self.icon.set_icon(Some(img));
        }
        let _ = self.icon.set_tooltip(Some(if active {
            "Live Caption Overlay — captioning"
        } else {
            "Live Caption Overlay — idle"
        }));
        let _ = self
            .toggle_item
            .set_text(if active { "Stop captioning" } else { "Start captioning" });
    }
}
