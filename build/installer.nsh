; Included by electron-builder's Windows installer (build/installer.nsh is its default include).
;
; Word documents (.doc, .docx) get Folio in "Open with", which converts them to PDF. They're registered here rather
; than in package.json's fileAssociations, which would also make Folio the default app and take double-click away
; from Word.

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\Folio.WordDocument" "" "Word Document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Folio.WordDocument\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Folio.WordDocument\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.docx\OpenWithProgids" "Folio.WordDocument"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.doc\OpenWithProgids" "Folio.WordDocument"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.docx\OpenWithProgids" "Folio.WordDocument"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.doc\OpenWithProgids" "Folio.WordDocument"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Folio.WordDocument"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
