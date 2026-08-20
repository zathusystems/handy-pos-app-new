# Handy POS Windows (.exe) Build Guide (Tauri)

This guide explains how to build the Windows **NSIS `.exe` installer** (and MSI) for Handy POS using Tauri.

## Build on GitHub Actions (beginner, no Windows PC)

Use this if you don’t have a Windows machine. It builds in GitHub’s CI without changing your local setup.

1. Push this repo to GitHub.
2. In your GitHub repo, go to **Settings → Secrets and variables → Actions** and add these **Repository secrets**: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_DJANGO_URL`.
3. Ensure this workflow file exists in the repo: `.github/workflows/windows-tauri-build.yml`.
4. Go to the **Actions** tab, open **Windows Tauri Build**, and click **Run workflow**.
5. When it finishes, download the artifact named `windows-installers`.

The workflow uploads the installers from:
- `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`
- `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/`

## 1. Prepare the Windows machine

Install these prerequisites on the Windows build machine:

1. **Git**  
   Download: `https://git-scm.com/download/win`
2. **Node.js LTS (includes npm)**  
   Download: `https://nodejs.org/en/download`
3. **Rust (via rustup)**  
   Download: `https://rustup.rs/`
4. **Visual Studio Build Tools**  
   Download: `https://visualstudio.microsoft.com/visual-cpp-build-tools/`  
   During install, select:
   - `Desktop development with C++`
   - `MSVC v143 - VS 2022 C++ x64/x86 build tools`
   - `Windows 10/11 SDK`
5. **Microsoft Edge WebView2 Runtime**  
   Download: `https://developer.microsoft.com/microsoft-edge/webview2/`  
   Choose **Evergreen Standalone Installer**.

Optional but useful:
1. **Windows Terminal** (from Microsoft Store)

## 2. Get the project

1. Open **PowerShell** or **Command Prompt**.
2. Clone the repo and enter it:

```bash
git clone <YOUR_REPO_URL> handy-pos
cd handy-pos
```

## 3. Configure build environment

These environment variables default to production if not set, but you can set them explicitly.

PowerShell:
```powershell
$env:NEXT_PUBLIC_API_URL="https://pos.zathusystems.com/api"
$env:NEXT_PUBLIC_API_BASE_URL="https://pos.zathusystems.com/api"
$env:NEXT_PUBLIC_DJANGO_URL="https://pos.zathusystems.com"
```

Command Prompt (cmd):
```bat
set NEXT_PUBLIC_API_URL=https://pos.zathusystems.com/api
set NEXT_PUBLIC_API_BASE_URL=https://pos.zathusystems.com/api
set NEXT_PUBLIC_DJANGO_URL=https://pos.zathusystems.com
```

## 4. Install dependencies

```bash
npm install
```

## 5. Build the Windows installer (recommended)

Use the Windows build script (creates **NSIS .exe** and **MSI**):

```bat
scripts\build-desktop.bat
```

This script will:
1. Install Node dependencies
2. Build the Next.js frontend
3. Build the Tauri Windows bundle

## 6. Manual build (alternative)

If you prefer manual commands:

1. Install Rust target:
```bash
rustup target add x86_64-pc-windows-msvc
```

2. Build Next.js:
```bash
npm run build
```

3. Build Tauri Windows bundle:
```bash
npm run tauri:build:windows:x64
```

## 7. Locate the output installers

After a successful build, the output will be here:

- **NSIS EXE:**  
  `src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\`
- **MSI:**  
  `src-tauri\target\x86_64-pc-windows-msvc\release\bundle\msi\`

The **NSIS `.exe`** is the standard Windows installer you can distribute.

## 8. Common build issues

1. **`error: linker link.exe not found`**
   - Visual Studio Build Tools were not installed correctly.
   - Reinstall and ensure `Desktop development with C++` is selected.

2. **`tauri` command not found**
   - Run `npm install` again; the Tauri CLI is installed locally.

3. **WebView2 missing**
   - Install WebView2 Runtime as described above.

## 9. Verify the build

1. Run the generated `.exe` installer.
2. Install and launch Handy POS.
3. Confirm it connects to the configured API URL.

---

If you want me to add code signing steps for the `.exe`, tell me the certificate type and I’ll extend the guide.
