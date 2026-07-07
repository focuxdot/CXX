' CXX remote daemon hidden launcher.
'
' Arguments:
'   0 = executable path, usually cxx-daemon.exe
'   1 = working directory
'   2... = executable arguments, usually start [--config path]
'
' WScript stays alive until the child exits, so Task Scheduler can observe failure
' and apply RestartOnFailure. The daemon writes its own daemon.log on Windows.
Option Explicit

Dim sh, exe, workdir, cmd, i, rc
Set sh = CreateObject("WScript.Shell")

If WScript.Arguments.Count < 3 Then WScript.Quit 2

exe = WScript.Arguments(0)
workdir = WScript.Arguments(1)
If Len(workdir) > 0 Then sh.CurrentDirectory = workdir

cmd = """" & exe & """"
For i = 2 To WScript.Arguments.Count - 1
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next

rc = sh.Run(cmd, 0, True)
WScript.Quit rc
