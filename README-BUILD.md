# Vidonia Desktop – build a Windows .exe

Requirements: Windows 10/11, Node.js 18 or newer (https://nodejs.org).

1. Open this folder in a terminal (PowerShell or Command Prompt).
2. Install dependencies (this also downloads the ffmpeg binary):
   npm install
3. Test the app before building:
   npm start
4. Build the installer:
   npm run dist
5. The installer is created in the `dist` folder, for example `dist\Vidonia Setup 1.0.0.exe`.
   Run it to install Vidonia like any normal Windows program.

Notes:
- The installer is not code-signed, so Windows SmartScreen may warn "unknown publisher". Click "More info" → "Run anyway". Removing this warning needs a paid code-signing certificate.
- Videos are processed on your computer. Nothing is uploaded.
- Google sign-in is not used in the desktop version.
