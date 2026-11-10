// Atelier 3D pour Windows : la page du dossier 3d/ dans une fenêtre, plus un accès direct au disque.
// Le programme ne fait que lire les dossiers choisis et écrire les images ou vidéos que l'on enregistre.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Fichiers reçus au lancement (double-clic sur un .3mf ou un .stl), remis une seule fois à la page.
struct Launch(Mutex<Vec<String>>);

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    dir: bool,
    size: u64,
    mtime: f64,
}

#[derive(Serialize)]
struct Info {
    version: String,
}

fn entry_of(path: &Path) -> Option<Entry> {
    let md = std::fs::metadata(path).ok()?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    Some(Entry {
        name: path.file_name()?.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        dir: md.is_dir(),
        size: md.len(),
        mtime,
    })
}

fn is_model(p: &Path) -> bool {
    p.extension()
        .map(|e| {
            let e = e.to_string_lossy().to_lowercase();
            e == "3mf" || e == "stl"
        })
        .unwrap_or(false)
}

/// Garde, parmi les arguments de la ligne de commande, les fichiers 3MF et STL qui existent.
fn model_args<I: IntoIterator<Item = String>>(args: I, cwd: Option<&Path>) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .filter_map(|a| {
            let mut p = PathBuf::from(&a);
            if p.is_relative() {
                if let Some(c) = cwd {
                    p = c.join(p);
                }
            }
            (p.is_file() && is_model(&p)).then(|| p.to_string_lossy().into_owned())
        })
        .collect()
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn header(req: &Request<'_>, name: &str) -> String {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(pct_decode)
        .unwrap_or_default()
}

#[tauri::command]
fn take_launch_files(state: State<'_, Launch>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

#[tauri::command]
fn app_info(app: AppHandle) -> Info {
    Info {
        version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let rd = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    Ok(rd.flatten().filter_map(|e| entry_of(&e.path())).collect())
}

#[tauri::command]
async fn stat_file(path: String) -> Result<Entry, String> {
    entry_of(Path::new(&path)).ok_or_else(|| "fichier introuvable".to_string())
}

#[tauri::command]
async fn dir_exists(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_folder(window: WebviewWindow) -> Option<String> {
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Choisir un dossier")
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Enregistre une image ou une vidéo : fenêtre « Enregistrer sous », puis écriture du fichier.
#[tauri::command]
async fn save_file(window: WebviewWindow, request: Request<'_>) -> Result<Option<String>, String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("contenu manquant".into());
    };
    let name = header(&request, "x-name");
    let desc = header(&request, "x-desc");
    let ext = header(&request, "x-ext");
    let mut dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Enregistrer")
        .set_file_name(&name);
    if !ext.is_empty() {
        dialog = dialog.add_filter(if desc.is_empty() { ext.as_str() } else { desc.as_str() }, &[ext.as_str()]);
    }
    let Some(target) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = target.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(Some(
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    ))
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("lien refusé".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

fn main() {
    let launch = model_args(
        std::env::args().skip(1),
        std::env::current_dir().ok().as_deref(),
    );
    tauri::Builder::default()
        // un seul Atelier 3D ouvert : un double-clic sur un autre fichier l'ajoute à la fenêtre existante
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let files = model_args(argv.into_iter().skip(1), Some(Path::new(&cwd)));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Launch(Mutex::new(launch)))
        .invoke_handler(tauri::generate_handler![
            take_launch_files,
            app_info,
            list_dir,
            stat_file,
            dir_exists,
            read_file,
            pick_folder,
            save_file,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("Atelier 3D n'a pas pu démarrer");
}
