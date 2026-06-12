Option Explicit

Dim shell
Dim command
Dim i
Dim exitCode

Set shell = CreateObject("WScript.Shell")
command = QuoteArg(shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"))

For i = 0 To WScript.Arguments.Count - 1
  command = command & " " & QuoteArg(CStr(WScript.Arguments(i)))
Next

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function QuoteArg(value)
  QuoteArg = """" & Replace(value, """", """""") & """"
End Function
