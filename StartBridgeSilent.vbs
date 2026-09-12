Option Explicit

Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

sh.CurrentDirectory = dir
sh.Run "cmd /c """"" & dir & "\StartDeadlock.bat""""", 0, False
