# OrbSniper portable launcher.
#
# Replaces electron-builder's stock portable.nsi (see scripts/dist.js). The
# stock one unpacks the whole app into %TEMP% on EVERY launch and deletes it
# on exit, which is why OrbSniper.exe used to take ~8 seconds to open. This
# one unpacks once into a per-build cache folder and afterwards just starts
# the app from there.
#
# The app is embedded as a 7z archive: the smallest exe we can ship. It is
# unpacked straight into the cache folder; the stock macro unpacks into a
# scratch folder first and copies everything over, doubling the disk work.
#
# The cache folder name carries a build id, so a new build can never run
# stale files, and older builds are cleaned up.

!include "common.nsh"

CRCCheck off
WindowIcon Off
AutoCloseWindow True
RequestExecutionLevel ${REQUEST_EXECUTION_LEVEL}

!ifndef APP_64
  !error "portable.nsi expects an x64 7z app package: leave portable.useZip off"
!endif
!ifndef BUILD_ID
  !error "BUILD_ID is not defined: build with npm run dist (scripts/dist.js)"
!endif

!define CACHE_ROOT "$LOCALAPPDATA\${PRODUCT_FILENAME}\runtime"
!define CACHE_DIR "${CACHE_ROOT}\${VERSION}-${BUILD_ID}"

Function launchApp
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_APP_FILENAME", "${APP_FILENAME}").r0'
  ${StdUtils.GetAllParameters} $R0 0
  SetOutPath "${CACHE_DIR}"
  # Exec, not ExecWait: this stub has nothing left to do once the app is up.
  Exec '"${CACHE_DIR}\${APP_EXECUTABLE_FILENAME}" $R0'
FunctionEnd

Function pruneOldBuilds
  FindFirst $0 $1 "${CACHE_ROOT}\*"
  loop:
    StrCmp $1 "" done
    StrCmp $1 "." next
    StrCmp $1 ".." next
    StrCmp $1 "${VERSION}-${BUILD_ID}" next
    # A build that is still running stays locked and simply survives until
    # the next launch.
    RMDir /r "${CACHE_ROOT}\$1"
  next:
    FindNext $0 $1
    Goto loop
  done:
  FindClose $0
FunctionEnd

Function .onInit
  !insertmacro check64BitAndSetRegView

  # Fast path: this exact build is already unpacked.
  ${If} ${FileExists} "${CACHE_DIR}\.complete"
  ${AndIf} ${FileExists} "${CACHE_DIR}\${APP_EXECUTABLE_FILENAME}"
    Call launchApp
    Quit
  ${EndIf}

  # A double-click while the first unpack is still running must not start a
  # second unpack into the same folder. The first one launches the app.
  System::Call 'kernel32::CreateMutex(p 0, i 1, t "OrbSniperPortableUnpack") p .r1 ?e'
  Pop $R0
  ${If} $R0 == 183
    Quit
  ${EndIf}

  # Everything happens right here in .onInit: the installer window is never
  # created, and Banner (unlike in a silent install) actually shows.
  Call unpack
  Call launchApp
  Quit
FunctionEnd

Function unpack
  InitPluginsDir
  # Only the first launch gets here, so say why it takes a moment.
  # The banner is small: one short line in both languages is all that fits.
  Banner::show /NOUNLOAD "Unpacking… / Распаковка…"

  RMDir /r "${CACHE_DIR}"
  SetOutPath "${CACHE_DIR}"

  # The archive is already 7z-compressed: compressing it again saves nothing.
  !ifdef COMPRESS
    SetCompress off
  !endif
  File /oname=$PLUGINSDIR\app-64.7z "${APP_64}"
  !ifdef COMPRESS
    SetCompress "${COMPRESS}"
  !endif

  Nsis7z::Extract "$PLUGINSDIR\app-64.7z"
  Delete "$PLUGINSDIR\app-64.7z"

  ${IfNot} ${FileExists} "${CACHE_DIR}\${APP_EXECUTABLE_FILENAME}"
    Banner::destroy
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)"
    RMDir /r "${CACHE_DIR}"
    Quit
  ${EndIf}

  # Written last: an unpack that was interrupted is simply redone next time.
  FileOpen $0 "${CACHE_DIR}\.complete" w
  FileWrite $0 "${VERSION}-${BUILD_ID}"
  FileClose $0

  Call pruneOldBuilds
  Banner::destroy
FunctionEnd

# Never reached (.onInit always quits), but NSIS wants a section.
Section
SectionEnd
