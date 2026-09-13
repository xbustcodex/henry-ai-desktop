AGENTS.md

Henry AI Desktop
================

MISSION
-------
Maintain one cross-platform Henry AI Desktop codebase.

Supported platform targets:
- Linux x64 — actively developed and tested
- Windows x64 — actively developed and tested
- macOS — preserve existing behavior; currently untested

Do not create separate platform forks.

PLATFORM ARCHITECTURE
---------------------
Shared application/core logic must remain platform-neutral.

OS-specific functionality belongs behind platform adapters:

darwin -> existing macOS implementation
linux  -> generic Linux implementation
win32  -> Windows implementation

Do not hardcode Kali behavior when generic Linux capability detection
can be used.

Do not remove or rewrite working macOS implementations merely because
they cannot currently be tested.

CORE LOGIC
----------
Do not unnecessarily platform-specialize:
- chat
- memory
- tasks
- reminders
- provider routing
- Ollama
- Groq/other AI providers
- sync
- business features
- journal
- habits
- common UI state

PLATFORM CAPABILITIES
---------------------
Platform-specific behavior includes:
- application launching
- installed application discovery
- clipboard
- selected-text capture
- screenshots/screen capture
- keyboard/mouse automation
- global shortcuts
- notifications
- shell/terminal
- process management
- system information
- permission/capability detection
- text-to-speech
- file manager
- settings launching
- desktop integration
- system paths

LINUX
-----
Linux must use capability detection where practical.

Account for:
- X11
- Wayland
- WSLg where applicable
- XDG_CURRENT_DESKTOP
- XDG_SESSION_TYPE
- DISPLAY
- WAYLAND_DISPLAY

Installed applications should be discovered from standard Linux
desktop metadata rather than a hardcoded macOS application list,
including:
- /usr/share/applications
- ~/.local/share/applications

Do not pretend macOS permission systems exist on Linux.

Replace macOS Accessibility and Screen Recording permission checks
with checks for the actual capabilities Henry requires.

RENDERER SECURITY
-----------------
Renderer code must not directly depend on Node built-ins.

Do not enable nodeIntegration to work around this.

Use Electron preload/contextBridge for privileged/platform information
and operations.

The Linux renderer previously crashed because renderer-reachable code
imported Node's `os` module and called os.platform() after Vite browser
externalization.

Do not reintroduce renderer imports such as:
- os
- fs
- child_process
- other Node-only modules

unless architecture explicitly keeps that module outside the renderer.

PLATFORM DETECTION
------------------
Use the existing preload/contextBridge platform API in renderer code.

Do not import Node `os` merely to determine the renderer platform.

Renderer platform utility: `src/utils/platform.ts` exports `getPlatform()`, `isMacOS()`, `isLinux()`, `isWindows()`, `getPlatformName()`. Use this instead of direct `window.henryAPI.platform()` calls.

MAIN PROCESS
------------
Node APIs may be used in main-process-only code where appropriate.

Keep privileged OS operations out of the renderer.

UI / ONBOARDING
---------------
Do not hardcode:
- Mac
- Finder
- Dock
- /Applications
- Option/Command shortcuts
- Apple System Settings
- macOS permission instructions

into shared UI.

Prefer neutral terminology such as:
- computer
- device
- file manager
- application
- settings

Use platform-specific wording only when the distinction matters.

Display actual registered shortcuts rather than assumed shortcuts.

Onboarding flow uses platform detection from `src/utils/platform.ts`:
- Welcome step shows platform-appropriate permission description
- Accessibility/Screen Recording steps skipped on Linux (capability-checked instead)
- Shortcuts display platform-appropriate labels (Alt+C on Linux, ⌥Space on macOS)
- Phone pairing instructions use "computer" / "device" not "Mac"
- Backup reminder says "your computer" not "your Mac"

Onboarding complete step shows platform-appropriate status summary.

Health panel uses platform-aware checks:
- Linux: capability checks (screen capture, clipboard, automation) instead of macOS permission names
- macOS: preserves existing Accessibility/Screen Recording permission checks
- Shortcut display uses actual registered shortcuts (Alt+C on Linux, ⌥Space on macOS)

AI PROVIDERS
------------
Preserve working local AI support.

Current Linux runtime has successfully detected and used:
- Ollama
- deepseek-r1:7b

Do not make Groq mandatory when a working local/provider configuration
already exists.

Do not expose API keys in logs, reports, tests, screenshots, or commits.

TESTING
-------
After meaningful changes run:

npm run typecheck
npm test
npm run build:web

For Linux release work:
npm run build:linux

Do not consider a renderer change verified solely because TypeScript,
tests, or Vite build succeeds.

Verify the production renderer actually mounts and the application UI
loads.

Run a single test file:
npm test -- path/to/test-file.test.ts

Run tests in watch mode:
npm test -- --watch

RELEASE TARGETS
---------------
Linux:
- AppImage
- DEB

Windows:
- x64 installer/EXE
- portable build if supported by existing builder configuration

macOS:
- preserve existing build configuration
- do not claim runtime verification without a Mac

USEFUL COMMANDS
---------------
Run a single test file:
npm test -- path/to/test-file.test.ts

Run tests in watch mode:
npm test -- --watch

Typecheck only:
npm run typecheck

Build web renderer:
npm run build:web

Build Linux packages:
npm run build:linux

Build all platforms:
npm run build

REGRESSION RULE
---------------
A platform fix must not silently remove functionality from another
platform.

When changing platform behavior:
1. identify shared behavior
2. identify OS-specific behavior
3. implement behind the appropriate abstraction
4. preserve existing implementations for other platforms
5. test available platforms

WORKFLOW
--------
For large platform changes:

1. Audit
2. Report findings
3. Design adapter boundary
4. Make incremental changes
5. Typecheck
6. Test
7. Production-build
8. Runtime-test
9. Package only after runtime verification

Do not perform large blind search-and-replace operations.

Do not modify generated/minified production bundles to fix source
problems.

Fix original source.

CURRENT LINUX BASELINE
----------------------
Confirmed:
- Electron application launches on Kali Linux/WSL
- production React renderer mounts
- onboarding completes
- main Henry UI loads
- Henry HQ loads
- Ollama integration works
- deepseek-r1:7b is detected
- global hotkeys report operational
- Henry Sync Server v3.0.7 runs
- Linux AppImage builds
- Linux DEB builds and installs

Known remaining platform work includes:
- macOS-specific onboarding
- macOS permission checks
- Mac shortcut labels
- Mac application catalogue
- Finder/Dock/System Settings assumptions
- Linux capability detection
- Linux application discovery
- Homebrew assumptions
- cloudflared Linux handling
- self-repair platform semantics

DO NOT BREAK THE WORKING BASELINE.
DO NOT BREAK THE WORKING BASELINE.
