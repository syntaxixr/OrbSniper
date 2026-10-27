# OrbSniper portable launcher.
#
# Replaces electron-builder's stock portable.nsi (see scripts/dist.js). The
# stock one unpacks the whole app (~320 MB) into %TEMP% on EVERY launch and
# deletes it on exit, which is why OrbSniper.exe used to take ~8 seconds to
# open. This one unpacks once into a per-build cache folder and afterwards
# just starts the app from there.
#
# The unpack itself is a single pass: the app files are stored in the exe
# with NSIS's own zlib compression ("useZip" in package.json) and written
# straight into the cache folder. The stock layout first copies a 7z archive
# out of the exe and then runs a much slower LZMA decoder over it.
#
# The cache folder name carries a build id, so a new build can never run
# stale files, and older builds are cleaned up.

!include "common.nsh"

CRCCheck off
WindowIcon Off
AutoCloseWindow True
RequestExecutionLevel ${REQUEST_EXECUTION_LEVEL}

!ifndef APP_DIR_64
  !error "portable.nsi expects the app as plain files: set portable.useZip in package.json"
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
  # Only the first launch gets here, so say why it takes a moment.
  # The banner is small: one short line in both languages is all that fits.
  Banner::show /NOUNLOAD "Unpacking… / Распаковка…"

  RMDir /r "${CACHE_DIR}"
  SetOutPath "${CACHE_DIR}"
  ClearErrors
  File /r "${APP_DIR_64}\*.*"

  ${If} ${Errors}
  ${OrIfNot} ${FileExists} "${CACHE_DIR}\${APP_EXECUTABLE_FILENAME}"
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
