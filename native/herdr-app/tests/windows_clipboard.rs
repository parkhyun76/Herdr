#![cfg(windows)]

use gpui::ClipboardItem;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[link(name = "user32")]
unsafe extern "system" {
    fn GetClipboardOwner() -> *mut std::ffi::c_void;
    fn OpenClipboard(owner: *mut std::ffi::c_void) -> i32;
    fn CloseClipboard() -> i32;
}

fn powershell(script: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    command.creation_flags(0x08000000);
    command
}

// Real Windows clipboard and another process, rather than TestPlatform's cache.
#[test]
fn windows_clipboard_cross_process_and_temporary_contention() {
    let platform = gpui_platform::current_platform(true);
    let original = platform.read_from_clipboard();
    struct Restore(std::rc::Rc<dyn gpui::Platform>, Option<ClipboardItem>);
    impl Drop for Restore {
        fn drop(&mut self) {
            if let Some(item) = self.1.take() {
                self.0.write_to_clipboard(item);
            }
        }
    }
    let _restore = Restore(platform.clone(), original);

    platform.write_to_clipboard(ClipboardItem::new_string("previous clipboard".into()));
    let mut holder = powershell(r#"
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ClipLock { [DllImport("user32.dll")] public static extern bool OpenClipboard(IntPtr h); [DllImport("user32.dll")] public static extern bool CloseClipboard(); }'
Add-Type -AssemblyName System.Windows.Forms
$owner = [System.Windows.Forms.Form]::new()
if (-not [ClipLock]::OpenClipboard($owner.Handle)) { exit 2 }
try { [Console]::WriteLine('locked'); [Console]::Out.Flush(); [void][Console]::ReadLine() } finally { [void][ClipLock]::CloseClipboard() }
"#).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let mut line = String::new();
    BufReader::new(holder.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert_eq!(line.trim(), "locked");
    let unexpectedly_opened = unsafe { OpenClipboard(std::ptr::null_mut()) } != 0;
    if unexpectedly_opened {
        unsafe { CloseClipboard() };
    }
    let mut release = holder.stdin.take().unwrap();
    let unlock = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));
        writeln!(release, "release").unwrap();
    });
    let text = "Herdr 복사 확인 😀\r\nsecond line\t한글";
    platform.write_to_clipboard(ClipboardItem::new_string(text.into()));
    unlock.join().unwrap();
    assert!(holder.wait().unwrap().success());
    assert!(
        !unexpectedly_opened,
        "test process must actually hold the clipboard"
    );
    assert_eq!(
        platform
            .read_from_clipboard()
            .and_then(|item| item.text())
            .as_deref(),
        Some(text)
    );
    assert!(
        !unsafe { GetClipboardOwner() }.is_null(),
        "clipboard writes need an owning window"
    );

    let output = powershell("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Write((Get-Clipboard -Raw))").output().unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap(), text);

    assert!(
        powershell("Set-Clipboard -Value 'external to Herdr'")
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(
        platform
            .read_from_clipboard()
            .and_then(|item| item.text())
            .as_deref(),
        Some("external to Herdr")
    );
    platform.write_to_clipboard(ClipboardItem::new_string("latest copy".into()));
    assert_eq!(
        platform
            .read_from_clipboard()
            .and_then(|item| item.text())
            .as_deref(),
        Some("latest copy")
    );

    let item =
        ClipboardItem::new_string_with_json_metadata("text with metadata".into(), vec![3, 4]);
    platform.write_to_clipboard(item.clone());
    assert_eq!(platform.read_from_clipboard(), Some(item));
    platform.write_to_clipboard(ClipboardItem::new_string(String::new()));
    assert_eq!(
        platform
            .read_from_clipboard()
            .and_then(|item| item.text())
            .as_deref(),
        None
    );

    let image = image::DynamicImage::new_rgba8(2, 3);
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    let item = ClipboardItem::new_image(&gpui::Image::from_bytes(
        gpui::ImageFormat::Png,
        bytes.into_inner(),
    ));
    platform.write_to_clipboard(item.clone());
    assert_eq!(platform.read_from_clipboard(), Some(item));
}
