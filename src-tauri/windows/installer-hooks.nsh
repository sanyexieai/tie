!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; This page runs before Tauri's reinstall page, which can uninstall an MSI.
; Old updaters pass /UPDATE but no location, and exit before installation starts.
Page custom TieSelectLegacyUpdateDirectory

Function TieSelectLegacyUpdateDirectory
  ${GetOptions} $CMDLINE "/UPDATE" $R0
  ${If} ${Errors}
    Abort
  ${EndIf}
  ${GetOptions} $CMDLINE "/TIE_CURRENT_INSTALL" $R0
  ${IfNot} ${Errors}
    Abort
  ${EndIf}

  choose_directory:
  nsDialogs::SelectFolderDialog "旧版未提供安装位置，请选择正在使用的 Tie 安装目录（包含 tie.exe）" "$INSTDIR"
  Pop $R0
  ${If} $R0 == "error"
    Quit
  ${EndIf}
  ${If} $R0 == ""
    Quit
  ${EndIf}
  ${IfNot} ${FileExists} "$R0\tie.exe"
    MessageBox MB_ICONEXCLAMATION "所选目录没有 tie.exe，请选择已有的 Tie 安装目录。"
    Goto choose_directory
  ${EndIf}
  StrCpy $INSTDIR $R0
  Abort
FunctionEnd
