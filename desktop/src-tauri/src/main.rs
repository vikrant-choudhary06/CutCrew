// CutCrew for Windows: opens the live CutCrew site in a native window
// (WebView2). The site does all the work, so the app updates with it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("CutCrew failed to start");
}
