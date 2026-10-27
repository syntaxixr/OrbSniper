# OrbSniper portable launcher.
#
# Replaces electron-builder's stock portable.nsi (see scripts/dist.js). The
# stock one unpacks the whole app (~250 MB) into %TEMP% on EVERY launch and
# deletes it on exit, which is why OrbSniper.exe used to take ~8 seconds to
# open. This one unpacks once into a per-build cache folder and afterwards
# just starts the app from there: the second launch onwards is instant.
#
# The cache folder name carries the hash of the embedded app archive, so a new
# build can never run stale files, and older builds are cleaned up.

!include "common.nsh"

CRCCheck off
WindowIcon Off
AutoCloseWindow True
RequestExecutionLevel ${REQUEST_EXECUTION_LEVEL}

!ifndef APP_64
  !error "portable.nsi expects an x64 7z app package"
!endif

!define CACHE_ROOT "$LOCALAPPDATA\${PRODUCT_FILENAME}\runtime"

Var cacheDir

!macro computeCacheDir
  !ifdef APP_64_HASH
    StrCpy $R9 "${APP_64_HASH}" 16
    StrCpy $cacheDir "${CACHE_ROOT}\${VERSION}-$R9"
  !else
    StrCpy $cacheDir "${CACHE_ROOT}\${VERSION}"
  !endif
!macroend

Function launchApp
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_APP_FILENAME", "${APP_FILENAME}").r0'
  ${StdUtils.GetAllParameters} $R0 0
  SetOutPath $cacheDir
  # Exec, not ExecWait: this stub has nothing left to do once the app is up.
  Exec '"$cacheDir\${APP_EXECUTABLE_FILENAME}" $R0'
FunctionEnd

Function pruneOldBuilds
  FindFirst $0 $1 "${CACHE_ROOT}\*"
  loop:
    StrCmp $1 "" done
    StrCmp $1 "." next
    StrCmp $1 ".." next
    StrCmp "${CACHE_ROOT}\$1" $cacheDir next
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
  !insertmacro computeCacheDir

  # Fast path: this exact build is already unpacked.
  ${If} ${FileExists} "$cacheDir\.complete"
  ${AndIf} ${FileExists} "$cacheDir\${APP_EXECUTABLE_FILENAME}"
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

  StrCpy $INSTDIR $cacheDir
  RMDir /r $INSTDIR
  SetOutPath $INSTDIR

  # The archive is already 7z-compressed: storing it again saves nothing.
  !ifdef COMPRESS
    SetCompress off
  !endif
  File /oname=$PLUGINSDIR\app-64.7z "${APP_64}"
  !ifdef COMPRESS
    SetCompress "${COMPRESS}"
  !endif

  # Straight into the cache folder: the stock macro unpacks into a scratch
  # folder first and copies everything over, which doubles the disk work.
  Nsis7z::Extract "$PLUGINSDIR\app-64.7z"
  Delete "$PLUGINSDIR\app-64.7z"

  ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    Banner::destroy
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)"
    RMDir /r $INSTDIR
    Quit
  ${EndIf}

  # Written last: an unpack that was interrupted is simply redone next time.
  FileOpen $0 "$INSTDIR\.complete" w
  FileWrite $0 "${VERSION}"
  FileClose $0

  Call pruneOldBuilds
  Banner::destroy
FunctionEnd

# Never reached (.onInit always quits), but NSIS wants a section.
Section
SectionEnd
