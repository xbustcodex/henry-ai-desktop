# Henry AI Platform Porting Plan: macOS → Linux/Kali

## Files That Need Modification

### 1. Core Platform-Specific Files
- `electron/voice/tts.ts` - Text-to-speech using macOS `say` command
- `src/henry/delegationInterceptor.ts` - App launching and control via `open -a` and `osascript`
- `electron/ipc/computer.ts` - Computer control IPC with extensive macOS dependencies
- `electron/ipc/syncBridge.ts` - Bridge service with macOS-specific shell commands

### 2. Configuration Files
- `electron-builder.config.js` - Build configuration needs Linux targets
- `package.json` - Build scripts and dependencies

## Linux Blockers Found

### Voice System (TTS)
- **Blocker**: `electron/voice/tts.ts` relies exclusively on macOS `say` command
- **Error**: Throws "Local speech uses the macOS say command — not available on this platform." on non-Darwin systems
- **Missing**: Linux TTS alternatives (eSpeak, Festival, or similar)

### App Launching & Control
- **Blocker**: Heavy use of `open -a` (macOS-specific) and `osascript` (AppleScript)
- **Locations**: 
  - `delegationInterceptor.ts`: Line 97 (`openCommand` construction)
  - `computer.ts`: Lines 83, 85, 87 (openApp handler)
  - `syncBridge.ts`: Multiple instances (lines 3362, 7473, 9136, etc.)
- **Missing**: Linux equivalents (`xdg-open`, `gtk-launch`, DBus controls)

### Clipboard Operations
- **Blocker**: Uses `pbcopy`/`pbpaste` macOS commands
- **Location**: `syncBridge.ts` lines 3288, 8354, 8367
- **Missing**: Linux clipboard utilities (`xclip`, `wl-clipboard`)

### System Controls & Information
- **Blocker**: AppleScript-based system controls
- **Locations**: 
  - `computer.ts`: Volume control, notifications, system stats
  - `syncBridge.ts`: Volume controls, system information gathering
- **Missing**: Linux alternatives (amixer/pactl, notify-send, /proc/sys)

### Screenshot Functionality
- **Blocker**: macOS `screencapture` command
- **Location**: `computer.ts` lines 48-61 (has Linux fallback but needs verification)
- **Status**: Partial Linux support exists (scrot/import) but may need refinement

### Electron Build Configuration
- **Blocker**: `electron-builder.config.js` exists but is empty
- **Missing**: Proper Linux build configuration for AppImage and .deb

## Implementation Plan

### Phase 1: Abstraction Layer Creation
Create platform abstraction utilities:
1. `src/platform/launcher.ts` - Cross-platform app opening
2. `src/platform/clipboard.ts` - Cross-platform clipboard operations
3. `src/platform/tts.ts` - Cross-platform text-to-speech
4. `src/platform/system.ts` - Cross-platform system controls (volume, notifications, etc.)
5. `src/platform/screenshot.ts` - Cross-platform screenshot capture

### Phase 2: Core File Modifications
#### 1. TTS System (`electron/voice/tts.ts`)
- Add Linux TTS support using `espeak` or `festival`
- Keep existing macOS `say` as primary for Darwin
- Add fallback chain: ElevenLabs → Local (platform-specific) → Web Speech API

#### 2. Delegation Interceptor (`src/henry/delegationInterceptor.ts`)
- Replace `open -a` with cross-platform launcher
- Replace `osascript` key commands with platform-specific input simulation
- For Linux: Use `xdotool` or similar for keyboard simulation

#### 3. Computer IPC (`electron/ipc/computer.ts`)
- **openApp**: Replace `open -a` with `xdg-open`/`gtk-launch`
- **AppleScript**: Replace with platform-specific alternatives:
  - Linux: Use `dbus-send` or `xdotool` for app control
  - Windows: Keep existing PowerShell/WSH
- **Screenshot**: Verify Linux `scrot`/`import` commands work
- **Permissions**: Remove macOS-specific checks, add Linux equivalents if needed
- **System Stats**: Replace macOS-specific commands with cross-platform alternatives
- **Volume/Brightness**: Use `amixer`/`pactl` and `ddcutil`/`brightnessctl`
- **Notifications**: Use `notify-send` (Linux) and `powershell` (Windows)

#### 4. SyncBridge (`electron/ipc/syncBridge.ts`)
- Replace `pbcopy`/`pbpaste` with cross-platform clipboard utility
- Replace `open -a` with cross-platform launcher
- Replace `osascript` with platform-specific system controls
- Update all macOS-specific shell commands to Linux equivalents

### Phase 3: Build Configuration Updates
#### 1. electron-builder.config.js
- Populate with proper Linux configuration:
  - AppImage and .deb targets
  - Proper icons and metadata
  - Linux-specific build options

#### 2. package.json
- Ensure build:linux script works correctly
- Add any Linux-specific dependencies if needed

### Phase 4: Dependency Management
- Add optional Linux dependencies:
  - `espeak-ng` or `festival` for TTS
  - `xdotool` for keyboard/mouse simulation
  - `wl-clipboard` or `xclip` for clipboard
  - `scrot` or `imagemagick` for screenshots
  - `notify-send` (libnotify-bin) for notifications
  - `amixer` or `pactl` for volume control
  - `ddcutil` or `brightnessctl` for brightness
- Document these as optional runtime dependencies

### Phase 5: Testing & Validation
- Test on Ubuntu/Debian-based Linux (primary target)
- Test on Kali Linux (specifically requested)
- Verify all existing macOS functionality works where possible
- Document any limitations or gaps in Linux support

## Preservation of Existing Functionality
- All macOS-specific code will be guarded by `process.platform === 'darwin'` checks
- Linux equivalents will be added in `else` blocks
- No existing macOS functionality will be removed
- Where exact parity isn't possible, graceful degradation will be implemented
- All changes will be backward compatible with existing macOS builds

## Estimated Effort
- **Voice System**: 2-3 hours
- **Delegation Interceptor**: 3-4 hours
- **Computer IPC**: 6-8 hours (most complex)
- **SyncBridge**: 4-5 hours
- **Build Configuration**: 1-2 hours
- **Testing & Validation**: 3-4 hours
- **Total**: Approximately 19-26 hours

## Risks and Mitigations
1. **Incomplete Linux equivalents**: Some macOS features have no direct Linux counterpart
   - Mitigation: Provide best-effort alternatives or clear error messages
2. **Dependency variability**: Linux installations vary widely
   - Mitigation: Make dependencies optional where possible, provide installation guidance
3. **Permission models**: Linux security models differ from macOS
   - Mitigation: Adapt permission checks to Linux equivalents (AppArmor, SELinux considerations)
4. **Testing coverage**: Limited ability to test all Linux distributions
   - Mitigation: Focus on Ubuntu/Debian and Kali as primary targets, document general approach